// Offline tests for the design-to-code/ layer. No Figma, no dependencies:  node test/design-to-code.test.ts
// Assertions pin VALUES (not just presence) and every confirmed bug has a regression test.
import { toDTCG, toCSS, toResolver, toTailwind, lintTokens, emitTokens, hexToColorValue, cssVarName, toNative, platformOf } from "../design-to-code/tokens.ts";
import { isCodeConnectMap, validateMap } from "../design-to-code/map-validate.ts";
import { driftLint, checkFreshness, DEFAULT_MAX_AGE_MS } from "../design-to-code/drift-lint.ts";
import { bootstrap } from "../design-to-code/map-bootstrap.ts";
import { isManifest } from "../design-to-code/catalog-input.ts";
import { getComponent, findComponent } from "../design-to-code/get-component.ts";
import { buildDesignSystemLayout } from "../bridge/src/design-system-layout.ts";
import { check, report } from "./assert.ts";
import type { PropDefInput, VariableInput } from "./fixtures.ts";
import {
  FixtureError, anyProp, asColor, asDimension, boolProp, catalog, codeMap, enumProp, fileAt, figmaExt, instanceProp, leafAt, malformed, modesOf, modifierOf, must, node, nodeAt, tokens,
} from "./fixtures.ts";
import { bag, isJsonObject } from "../design-to-code/types.ts";
import { isComponentsCatalog, isTokensDoc } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import type { CodeConnectMap, ComponentPropDef, ComponentsCatalog, DesignSystemDoc, DriftFinding, TokensDoc } from "../design-to-code/types.ts";
import type { GetComponentResult } from "../design-to-code/get-component.ts";
import type { DtcgGroup } from "../design-to-code/tokens.ts";
import { errCode, errMsg, firstLine } from "../bridge/src/errmsg.ts";
import { sha256Hex } from "../bridge/src/hash.ts";
import { isRecord } from "../bridge/src/json-util.ts";
import { mergeScreenIndex } from "../bridge/src/pages-layout.ts";
import { NUMERIC_TEXT, isAlias, isComposed } from "../design-to-code/doc-guards.ts";
import { alnumKey } from "../design-to-code/map-util.ts";
import { CUT_SETTLE_MS, driveInteractions, holdContext, raceBudget } from "../design-to-code/probe-drive.ts";
import type { Held } from "../design-to-code/probe-drive.ts";
import type { BrowserContext } from "playwright";
import { driveOutcome } from "../design-to-code/verify-probe.ts";
import { PAINT_TYPES, idSuffix, normText } from "../design-to-code/probe-match.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// `a` may be an optional channel (alpha): absent is "not near" — what `Math.abs(undefined - b) < 0.001` (NaN) said.
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 0.001;

type Found = Extract<GetComponentResult, { found: true }>;
const foundOf = (r: GetComponentResult): Found => must(r.found ? r : null, "getComponent to find the component");

// ---------- clean design system (no collisions/danglers) for value assertions ----------
const ds = tokens({
  exportedAt: new Date().toISOString(),
  file: "Test File",
  colorProfile: "srgb",
  collections: [{ name: "Primitives", modes: ["Value"], default: "Value" }, { name: "Semantic", modes: ["Light", "Dark"], default: "Light", theming: true }],
  variables: [
    { name: "blue/600", type: "COLOR", collection: "Primitives", values: { Value: "#2563eb" } },
    { name: "blue/300", type: "COLOR", collection: "Primitives", values: { Value: "#93c5fd" } },
    { name: "color/primary", type: "COLOR", collection: "Semantic", values: { Light: { aliasOf: "blue/600" }, Dark: { aliasOf: "blue/300" } }, scopes: ["FRAME_FILL"], codeSyntax: { WEB: "var(--color-primary)" }, description: "Primary brand" },
    { name: "color/muted", type: "COLOR", collection: "Semantic", values: { Light: { aliasOf: "blue/600" }, Dark: { aliasOf: "blue/600" } } }, // Dark == Light -> dedup
    { name: "space/md", type: "FLOAT", collection: "Primitives", values: { Value: 16 } },
  ],
});
// The same design system's component catalog (components.local.json).
const dsCat = catalog([
    { name: "Button", id: "1:1", type: "COMPONENT", key: "KEY_BTN", props: {
      Variant: { key: "Variant", type: "VARIANT", options: ["Primary", "Secondary"], default: "Primary" },
      Disabled: { key: "Disabled", type: "BOOLEAN", default: false }, Label: { key: "Label", type: "TEXT" }, Icon: { key: "Icon", type: "INSTANCE_SWAP" } } },
    { name: "Card", id: "2:2", type: "COMPONENT", key: "KEY_CARD", props: {} },
], { exportedAt: new Date().toISOString(), file: "Test File", colorProfile: "srgb" });

// ---------- tokens: DTCG VALUES (M2: assert the actual channels, not just length) ----------
console.log("tokens — DTCG:");
const dtcg = toDTCG(ds);
const c600 = asColor(leafAt(dtcg, "blue.600").$value).components;
check("primitive color RGB channels correct", near(c600[0], 0.1451) && near(c600[1], 0.3882) && near(c600[2], 0.9216) && asColor(leafAt(dtcg, "blue.600").$value).hex === "#2563eb");
check("alias PRESERVED as reference", leafAt(dtcg, "color.primary").$value === "{blue.600}");
check("per-mode values under $extensions (figma.com)", modesOf(leafAt(dtcg, "color.primary")).Dark === "{blue.300}");
check("scopes + codeSyntax in $extensions (figma.com)", figmaExt(leafAt(dtcg, "color.primary")).scopes?.[0] === "FRAME_FILL" && figmaExt(leafAt(dtcg, "color.primary")).codeSyntax?.WEB === "var(--color-primary)");
// DTCG 2025.10: a length is $type "dimension" with the OBJECT value {value, unit:"px"|"rem"}; a bare
// number under "dimension" (or a length typed as "number") is what Style Dictionary emits unitless.
check("length FLOAT -> dimension {value, unit:'px'} (DTCG 2025.10 object form)", leafAt(dtcg, "space.md").$type === "dimension" && asDimension(leafAt(dtcg, "space.md").$value).value === 16 && asDimension(leafAt(dtcg, "space.md").$value).unit === "px");
check("unitless FLOAT (OPACITY scope) stays $type number + literal", (() => { const d = toDTCG(tokens({ variables: [{ name: "opacity/disabled", type: "FLOAT", scopes: ["OPACITY"], values: { v: 0.5 } }] })); return leafAt(d, "opacity.disabled").$type === "number" && leafAt(d, "opacity.disabled").$value === 0.5; })());
check("dimension: aliases stay references, per-mode values get the object form too", (() => {
  const d = toDTCG(tokens({ collections: [{ name: "S", modes: ["Compact", "Cozy"], default: "Compact" }], variables: [
    { name: "space/base", type: "FLOAT", collection: "S", values: { Compact: 8, Cozy: 12 } },
    { name: "space/gap", type: "FLOAT", collection: "S", values: { Compact: { aliasOf: "space/base" }, Cozy: { aliasOf: "space/base" } } }] }));
  const m = modesOf(leafAt(d, "space.base"));
  return leafAt(d, "space.gap").$type === "dimension" && leafAt(d, "space.gap").$value === "{space.base}" && asDimension(m.Cozy).value === 12 && asDimension(m.Cozy).unit === "px";
})());
check("DTCG and CSS agree on which FLOATs are lengths (one unitDecision, opts.unitless honoured)", (() => {
  const one = tokens({ variables: [{ name: "z/modal", type: "FLOAT", values: { v: 100 } }] }), opts = { unitless: new Set(["z/modal"]) };
  const e = emitTokens(one, opts);
  return leafAt(e.dtcg, "z.modal").$type === "number" && leafAt(e.dtcg, "z.modal").$value === 100 && e.css.includes("--z-modal: 100;");
})());
check("description -> $description", leafAt(dtcg, "color.primary").$description === "Primary brand");
check("clean ds lints clean", lintTokens(ds).length === 0);
// DTCG 2025.10 conformance: no typeless leaves; 6-digit hex fallback; boolean coerced not dropped.
check("[T-str-type] STRING -> $type:'string' (valid, not typeless)", (() => { const d = toDTCG(tokens({ variables: [{ name: "font/sans", type: "STRING", values: { v: "Inter" } }] })); return leafAt(d, "font.sans").$type === "string" && leafAt(d, "font.sans").$value === "Inter"; })());
check("[T-bool-coerce] BOOLEAN -> $type:'string' + origin in $extensions (no typeless leaf)", (() => { const w: string[] = []; const d = toDTCG(tokens({ variables: [{ name: "flag/on", type: "BOOLEAN", values: { v: true } }] }), w); return leafAt(d, "flag.on").$type === "string" && leafAt(d, "flag.on").$value === "true" && figmaExt(leafAt(d, "flag.on")).originalType === "boolean" && w.some((m) => /BOOLEAN/.test(m)); })());
check("[T-6hex] color leaf hex fallback always 6-digit, alpha split out (2025.10)", (() => { const d = toDTCG(tokens({ variables: [{ name: "scrim", type: "COLOR", values: { v: "#00000080" } }] })); return asColor(leafAt(d, "scrim").$value).hex === "#000000" && near(asColor(leafAt(d, "scrim").$value).alpha, 0.502); })());
check("[fixtures-null] asColor(null) throws a FixtureError ('not a DTCG colour…'), not a raw TypeError", (() => {
  try { asColor(malformed(null)); return false; } catch (e) { return e instanceof FixtureError && /^not a DTCG colour/.test(e.message); }
})());

// ---------- tokens: color hardening ----------
console.log("tokens — color:");
check("shorthand #fff -> full color object", (() => { const v = must(hexToColorValue("#fff"), "hexToColorValue('#fff')"); return v.hex === "#ffffff" && near(v.components[0], 1) && near(v.components[2], 1); })());
check("alpha in `alpha` field, hex fallback stays 6-digit (DTCG 2025.10)", (() => { const v = must(hexToColorValue("#00000080"), "hexToColorValue('#00000080')"); return v.hex === "#000000" && near(v.alpha, 0.502); })());
check("malformed hex -> null (caller can guard)", hexToColorValue("#12345") === null);
check("P3 profile -> display-p3", hexToColorValue("#2563eb", "display-p3")?.colorSpace === "display-p3");

// ---------- tokens: CSS ----------
console.log("tokens — CSS:");
const css = toCSS(ds);
check("semantic -> var chain", css.includes("--color-primary: var(--blue-600);"));
check("primitive hex emitted EXACTLY once", (css.match(/--blue-600: #2563eb;/g) || []).length === 1);
check("FLOAT emitted with px unit", css.includes("--space-md: 16px;"));
check("cssVarName preserves case (custom props are case-sensitive)", cssVarName("color/Text Primary") === "--color-Text-Primary");
const darkBlock = (css.match(/\[data-theme="Dark"\]\s*\{([^}]*)\}/) || [])[1] || "";
check("dark block overrides differing token", darkBlock.includes("--color-primary: var(--blue-300);"));
check("per-mode dedup: equal-to-default token has NO override", !darkBlock.includes("color-muted"));

// ---------- tokens: DTCG Resolver Module 2025.10 ----------
// Spec: designtokens.org/tr/2025.10/resolver/ — `version` (MUST be "2025.10") and `resolutionOrder`
// are the only REQUIRED root keys; a set MUST have `sources`; a modifier MUST have a non-empty
// `contexts` map and its `default` MUST be one of its context keys.
console.log("tokens — resolver:");
const rw: string[] = [];
const { resolver: rz, files: rzFiles } = toResolver(ds, rw);
check("required root shape: version '2025.10' + resolutionOrder array", rz.version === "2025.10" && Array.isArray(rz.resolutionOrder) && rz.$schema === "https://www.designtokens.org/schemas/2025.10/resolver.json");
check("every set has a `sources` array of reference objects that name an emitted file", Object.keys(rz.sets).length === 2 && Object.values(rz.sets).every((s) => Array.isArray(s.sources) && s.sources.every((src) => typeof src.$ref === "string" && fileAt(rzFiles, src.$ref))));
check("multi-mode collection -> modifier with both contexts + spec-valid default", (() => {
  const m = modifierOf(rz, "Semantic");
  return Object.keys(m.contexts).sort().join(",") === "Dark,Light" && m.default === "Light" && Object.keys(m.contexts).includes(m.default);
})());
check("single-mode collection contributes a set but NO modifier", rz.sets.Primitives !== undefined && (rz.modifiers || {}).Primitives === undefined);
const semanticMod = modifierOf(rz, "Semantic");
const semanticLightCtx = must(semanticMod.contexts.Light, "Semantic modifier Light context");
const semanticDarkCtx = must(semanticMod.contexts.Dark, "Semantic modifier Dark context");
check("default-mode context is the empty array (nothing differs), no file written", Array.isArray(semanticLightCtx) && semanticLightCtx.length === 0);
const darkSet = fileAt(rzFiles, must(semanticDarkCtx[0], "Semantic Dark context[0]").$ref);
check("context set holds ONLY the differing token (same dedup as toCSS)", nodeAt(darkSet, "color.primary") !== undefined && nodeAt(darkSet, "color.muted") === undefined);
const primitivesSet = must(rz.sets.Primitives, "resolver set 'Primitives'");
const semanticSet = must(rz.sets.Semantic, "resolver set 'Semantic'");
check("aliases preserved as {a.b} references in set files (resolved only at resolution time)", leafAt(darkSet, "color.primary").$value === "{blue.300}" && leafAt(fileAt(rzFiles, must(semanticSet.sources[0], "Semantic set sources[0]").$ref), "color.primary").$value === "{blue.600}");
check("dimensions keep the 2025.10 object form inside set files", (() => { const base = fileAt(rzFiles, must(primitivesSet.sources[0], "Primitives set sources[0]").$ref); return leafAt(base, "space.md").$type === "dimension" && asDimension(leafAt(base, "space.md").$value).value === 16 && asDimension(leafAt(base, "space.md").$value).unit === "px"; })());
check("set files carry no $extensions.modes (the resolver IS the mode mechanism)", leafAt(fileAt(rzFiles, must(semanticSet.sources[0], "Semantic set sources[0]").$ref), "color.primary").$extensions === undefined);
check("resolutionOrder refs resolve in-document, sets before modifiers", (() => {
  const ptrs = rz.resolutionOrder.map((r) => r.$ref);
  const idx = ptrs.findIndex((p) => p.startsWith("#/modifiers/"));
  // JSON-pointer walk: an object is stepped into; a falsy value stays as-is; a truthy scalar has no such member.
  const resolve = (p: string) => p.split("/").slice(1).reduce<unknown>((o, k) => (o && typeof o === "object" ? bag(o)[k.replace(/~1/g, "/").replace(/~0/g, "~")] : o ? undefined : o), rz);
  return ptrs.length === 3 && ptrs.every((p) => resolve(p) !== undefined) && idx === 2;
})());
check("emitTokens/CLI surface: resolver + files alongside the UNCHANGED dtcg/css outputs", (() => {
  const e = emitTokens(ds);
  return e.resolver.version === "2025.10" && Object.keys(e.resolverFiles).every((k) => k.startsWith("tokens/") && k.endsWith(".json"))
    && JSON.stringify(e.dtcg) === JSON.stringify(toDTCG(ds)) && modesOf(leafAt(e.dtcg, "color.primary")).Dark === "{blue.300}";
})());
check("single-mode-only design system -> valid resolver with NO modifiers key", (() => {
  const r = toResolver(tokens({ collections: [{ name: "P", modes: ["Value"], default: "Value" }], variables: [{ name: "a/b", type: "COLOR", collection: "P", values: { Value: "#000000" } }] })).resolver;
  return r.modifiers === undefined && r.version === "2025.10" && r.resolutionOrder.length === 1;
})());
check("filename collision after sanitizing -> warned + disambiguated, never overwritten", (() => {
  const w: string[] = [];
  const r = toResolver(tokens({ collections: [{ name: "C", modes: ["Light", "light", "LIGHT"], default: "Light" }], variables: [
    { name: "bg", type: "COLOR", collection: "C", values: { Light: "#111111", light: "#222222", LIGHT: "#333333" } }] }), w);
  const refs = ["light", "LIGHT"].map((m) => must(must(modifierOf(r.resolver, "C").contexts[m], `context '${m}'`)[0], `context '${m}'[0]`).$ref);
  return refs[0] !== refs[1] && new Set(refs).size === 2 && Object.keys(r.files).length === 3
    && asColor(leafAt(fileAt(r.files, refs[0]), "bg").$value).hex === "#222222" && asColor(leafAt(fileAt(r.files, refs[1]), "bg").$value).hex === "#333333"
    && w.some((m) => /collides/.test(m));
})());
check("`__proto__` mode name neither pollutes nor vanishes", (() => {
  // Parsed, not built: JSON.parse is what creates a REAL own "__proto__" key (an object literal would set the prototype).
  const parsed: unknown = JSON.parse('{"collections":[{"name":"C","modes":["Light","__proto__"],"default":"Light","theming":true}],"variables":[{"name":"bg","type":"COLOR","collection":"C","tier":"primitive","values":{"Light":"#111111","__proto__":"#222222"}}]}');
  if (!isTokensDoc(parsed)) return false;
  const r = toResolver(parsed);
  const ctx = modifierOf(r.resolver, "C").contexts;
  const ref = Object.prototype.hasOwnProperty.call(ctx, "__proto__") ? must(must(ctx["__proto__"], "context '__proto__'")[0], "context '__proto__'[0]").$ref : undefined;
  const reparsed: unknown = JSON.parse(JSON.stringify(r.resolver));
  return ref !== undefined && asColor(leafAt(fileAt(r.files, ref), "bg").$value).hex === "#222222" && bag({}).bg === undefined
    && isJsonObject(reparsed) && isJsonObject(reparsed.modifiers) && isJsonObject(reparsed.modifiers.C) && isJsonObject(reparsed.modifiers.C.contexts)
    && Object.prototype.hasOwnProperty.call(reparsed.modifiers.C.contexts, "__proto__");
})());
check("round-trip: base + context in resolutionOrder reproduces $extensions.modes exactly", (() => {
  const d = toDTCG(ds);
  const flat = (tree: DtcgGroup, prefix: string, out: Record<string, unknown>): Record<string, unknown> => { for (const k of Object.keys(tree)) { const n = must(tree[k], `DTCG node '${k}'`); const p = prefix ? prefix + "." + k : k; if ("$value" in n) out[p] = n.$value; else flat(n, p, out); } return out; };
  const modes = ["Light", "Dark"];
  return modes.every((mode) => {
    const merged: Record<string, unknown> = {};
    for (const item of rz.resolutionOrder) { // spec ordering: later entries override earlier ones
      if (item.$ref.startsWith("#/sets/")) { const setName = item.$ref.slice(7); const s = must(rz.sets[setName], `resolver set '${setName}'`); for (const src of s.sources) Object.assign(merged, flat(fileAt(rzFiles, src.$ref), "", {})); }
      else { const m = modifierOf(rz, item.$ref.slice(12)); const ctx = must(m.contexts[mode] || m.contexts[m.default], `context for mode '${mode}'`); for (const src of ctx) Object.assign(merged, flat(fileAt(rzFiles, src.$ref), "", {})); }
    }
    const expected = flat(d, "", {});
    for (const p of Object.keys(expected)) {
      const leaf = leafAt(d, p);
      const ext = leaf.$extensions && leaf.$extensions["figma.com"];
      const want = ext && ext.modes && ext.modes[mode] !== undefined ? ext.modes[mode] : expected[p];
      if (JSON.stringify(merged[p]) !== JSON.stringify(want)) return false;
    }
    return Object.keys(merged).length === Object.keys(expected).length;
  });
})());
check("resolver emits no NEW warnings on a clean design system", rw.length === 0 && lintTokens(ds).length === 0);

// ---------- tokens: never-silent lint ----------
console.log("tokens — lint:");
check("group/leaf collision reported (no silent loss)", lintTokens(tokens({ variables: [{ name: "color", type: "COLOR", values: { v: "#111111" } }, { name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }] })).some((w) => /collide/.test(w)));
check("collision does not produce an illegal both-$value-and-child node", (() => { const d = toDTCG(tokens({ variables: [{ name: "color", type: "COLOR", values: { v: "#111111" } }, { name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }] })); const c = nodeAt(d, "color"); return !(c !== undefined && "$value" in c && "primary" in c); })());
check("no-value-in-any-mode reported + skipped", (() => { const w: string[] = []; const d = toDTCG(tokens({ variables: [{ name: "x", type: "COLOR", values: {} }] }), w); return w.some((m) => /no value/.test(m)) && nodeAt(d, "x") === undefined; })());
check("toCSS never emits `undefined`", !toCSS(tokens({ collections: [{ name: "C", modes: ["Light", "Dark"], default: "Light" }], variables: [{ name: "bg", type: "COLOR", collection: "C", values: { Dark: "#000000" } }] })).includes("undefined"));
check("dangling alias reported", lintTokens(tokens({ variables: [{ name: "a", type: "COLOR", values: { v: { aliasOf: "does/not/exist" } } }] })).some((w) => /undefined token/.test(w)));
check("empty-name skipped in CSS (no `--:`)", !toCSS(tokens({ variables: [{ name: "", type: "COLOR", values: { v: "#abcdef" } }] })).includes("--:"));
check("var-name collision from distinct names reported", lintTokens(tokens({ variables: [{ name: "spacing/4", type: "FLOAT", values: { v: 16 } }, { name: "spacing-4", type: "FLOAT", values: { v: 99 } }] })).some((w) => /fold onto one identifier and resolve DIFFERENTLY/.test(w)));
check("and BOTH are emitted — nothing overwritten", (() => {
  const css = toCSS(tokens({ variables: [{ name: "spacing/4", type: "FLOAT", values: { v: 16 } }, { name: "spacing-4", type: "FLOAT", values: { v: 99 } }] }));
  return /: 16px;/.test(css) && /: 99px;/.test(css);
})());

// ---------- map validation (B2: additionalProperties + per-kind oneOf) ----------
console.log("map — validation:");
const ok = (m: unknown) => validateMap(m).ok;
const okEntry = { figma: { name: "B" }, code: { module: "m", export: "E" } };
check("valid minimal passes", ok({ version: 1, components: { K: okEntry } }));
check("missing code.export fails", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m" } } } }));
check("bad prop kind fails", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "weird", codeProp: "p" } } } } }));
check("unknown key on entry rejected (additionalProperties)", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, bogus: 1 } } }));
check("typo'd figma key rejected", !ok({ version: 1, components: { K: { figma: { name: "B", naem: "x" }, code: { module: "m", export: "E" } } } }));
check("extra top-level key rejected", !ok({ version: 1, components: {}, junk: 1 }));
check("enum prop carrying `slot` rejected (per-kind oneOf)", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "enum", codeProp: "p", slot: "x" } } } } }));
check("string prop carrying `values` rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "string", codeProp: "p", values: { a: "b" } } } } } }));
check("instance `slot` as number rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "instance", slot: 5 } } } } }));
check("enum default as object rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "enum", codeProp: "p", default: { x: 1 } } } } } }));
check("boolean default as string rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "boolean", codeProp: "p", default: "yes" } } } } }));
check("variantOverrides.when non-string value rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, variantOverrides: [{ when: { size: 5 }, code: { module: "m", export: "E" } }] } } }));
check("childrenByLayer junk key rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, childrenByLayer: { layerNamePattern: "*", nope: 1 } } } }));
check("valid full entry (targets/variantOverrides/childrenByLayer/instance) passes", ok({ version: 1, components: { K: { figma: { name: "B", key: "k" }, code: { module: "m", export: "E", targets: { web: { module: "w", export: "W" } } }, props: { I: { kind: "instance", slot: "icon" } }, variantOverrides: [{ when: { Type: "Danger" }, code: { module: "d", export: "D" } }], childrenByLayer: { slot: "children" } } } }));
check("null map fails gracefully", validateMap(null).ok === false);
// an entry may carry a free-text `note` (build-screen leaves one); it must be a string.
check("an entry with note:\"…\" validates", ok({ version: 1, components: { K: { ...okEntry, status: "active", note: "props mapped by hand" } } }));
check("note: 3 fails with 'must be a string' at components.K.note", (() => {
  const r = validateMap({ version: 1, components: { K: { ...okEntry, note: 3 } } });
  return !r.ok && r.errors.length === 1 && r.errors[0]?.path === "components.K.note" && r.errors[0]?.message === "must be a string";
})());

// ---------- drift lint ----------
console.log("drift — lint:");
const single = (props?: Record<string, PropDefInput>) => catalog([{ key: "K", name: "Btn", type: "COMPONENT", props: props || {} }]);
// deleted mapped component is ORPHANED, not silently rebound by name.
const f1 = driftLint(codeMap({ K_DELETED: { figma: { key: "K_DELETED", name: "Button", id: "9:9" } } }), catalog([{ key: "K_LIVE", id: "1:1", name: "Button", type: "COMPONENT" }]));
check("deleted key -> orphaned error (not name-rebind)", f1.errors.some((e) => e.code === "orphaned-entry" && e.suggestedKey === "K_LIVE"));
// unpublished component keyed by node id matches.
check("unpublished component keyed by id matches (no false error)", driftLint(codeMap({ "3:3": { figma: { name: "Card", id: "3:3" }, code: { module: "m", export: "E" } } }), catalog([{ id: "3:3", name: "Card", type: "COMPONENT" }])).errors.length === 0);
// figma.key wins over an incidental map-key collision.
const f5 = driftLint(codeMap({ Primary: { figma: { key: "REAL", name: "Primary" } } }), catalog([{ key: "Primary", id: "1:1", name: "Danger", type: "COMPONENT" }, { key: "REAL", id: "2:2", name: "Primary", type: "COMPONENT" }]));
check("figma.key outranks map-key collision (no fabricated rename)", !f5.errors.length && !f5.warnings.some((w) => w.code === "stale-name") && f5.warnings.some((w) => w.code === "unmapped-component" && w.name === "Danger"));
// #uid prop suffix normalized on both sides.
check("#uid prop suffix does not cause false stale-prop", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { "Size#12:3": { kind: "enum", codeProp: "size", values: { sm: "s", lg: "l" } } } } }), single({ "Size": { type: "VARIANT", options: ["sm", "lg"] } })).errors.length === 0);
// VARIANT with no options -> warn, not false error.
const f7 = driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { Size: { kind: "enum", codeProp: "s", values: { bogus: "x" } } } } }), single({ Size: { type: "VARIANT" } }));
check("VARIANT missing options -> warning, no false error", f7.warnings.some((w) => w.code === "no-variant-options") && !f7.errors.length);
// double-map detected.
check("two entries -> one component reported", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" } }, K2: { figma: { key: "K", name: "Btn" } } }), single()).errors.some((e) => e.code === "double-mapped"));
// duplicate catalog key -> warn, shadowed twin NOT falsely unmapped.
const f4 = driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" } } }), catalog([{ key: "K", id: "1:1", name: "A", type: "COMPONENT" }, { key: "K", id: "2:2", name: "B", type: "COMPONENT" }]));
check("duplicate catalog key warned, no spurious unmapped", f4.warnings.some((w) => w.code === "duplicate-key") && !f4.warnings.some((w) => w.code === "unmapped-component"));
// unknown variant value -> error.
check("mapping a non-existent variant option -> error", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { Size: { kind: "enum", codeProp: "s", values: { nope: "x" } } } } }), single({ Size: { type: "VARIANT", options: ["sm"] } })).errors.some((e) => e.code === "unknown-variant-value"));
// still-caught basics + a genuinely clean map is warning-clean too.
check("kind mismatch caught", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { Size: { kind: "boolean", codeProp: "s" } } } }), single({ Size: { type: "VARIANT", options: ["a"] } })).errors.some((e) => e.code === "kind-mismatch"));
check("stale prop caught", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { Ghost: { kind: "boolean", codeProp: "g" } } } }), single()).errors.some((e) => e.code === "stale-prop"));
const clean = driftLint(codeMap({
  KEY_BTN: { figma: { key: "KEY_BTN", name: "Button" }, code: { module: "m", export: "E" }, props: { Variant: { kind: "enum", codeProp: "v", values: { Primary: "primary", Secondary: "secondary" } }, Disabled: { kind: "boolean", codeProp: "d" }, Label: { kind: "string", codeProp: "children" }, Icon: { kind: "instance", slot: "icon" } } },
  KEY_CARD: { figma: { key: "KEY_CARD", name: "Card" }, code: { module: "m", export: "C" } },
}), dsCat);
check("complete map is error- AND warning-clean", clean.errors.length === 0 && clean.warnings.length === 0);

console.log("drift — staleness:");
const emptyMap = codeMap({});
check("missing exportedAt -> unknown-freshness warning", driftLint(emptyMap, catalog([])).warnings.some((w) => w.code === "unknown-freshness"));
check("unparseable exportedAt -> unknown-freshness warning", driftLint(emptyMap, { exportedAt: "not-a-date", components: [] }).warnings.some((w) => w.code === "unknown-freshness"));
check("fresh export (1h old, default 24h max) -> no staleness warning at all", driftLint(emptyMap, { exportedAt: new Date(Date.now() - 3600000).toISOString(), components: [] }).warnings.every((w) => w.code !== "stale-snapshot" && w.code !== "unknown-freshness"));
check("export older than default 24h max-age -> stale-snapshot warning", driftLint(emptyMap, { exportedAt: new Date(Date.now() - 30 * 3600000).toISOString(), components: [] }).warnings.some((w) => w.code === "stale-snapshot"));
check("stale-snapshot message names the file and is unmistakably prominent", (() => {
  const w = driftLint(emptyMap, { exportedAt: new Date(Date.now() - 30 * 3600000).toISOString(), file: "My File", components: [] }).warnings.find((w) => w.code === "stale-snapshot");
  return w !== undefined && /^STALE SNAPSHOT/.test(w.message) && w.message.includes("My File");
})());
check("never silently passes: EVERY driftLint result carries a freshness verdict (warning or explicit pass)", (() => {
  const fresh = driftLint(emptyMap, { exportedAt: new Date().toISOString(), components: [] });
  return fresh.freshness === undefined && fresh.warnings.every((w) => w.code !== "stale-snapshot" && w.code !== "unknown-freshness");
})());
check("--max-age override via opts.maxAgeMs: a 30h-old export is fine at 48h max", driftLint(emptyMap, { exportedAt: new Date(Date.now() - 30 * 3600000).toISOString(), components: [] }, { maxAgeMs: 48 * 3600000 }).warnings.every((w) => w.code !== "stale-snapshot"));
check("--max-age override makes a normally-fresh export stale at a tight threshold", driftLint(emptyMap, { exportedAt: new Date(Date.now() - 3600000).toISOString(), components: [] }, { maxAgeMs: 1800000 }).warnings.some((w) => w.code === "stale-snapshot"));
check("checkFreshness default max-age constant is 24h", DEFAULT_MAX_AGE_MS === 24 * 3600000);
check("checkFreshness's returned warning matches what it pushed into the array", (() => {
  const warnings: DriftFinding[] = [];
  const push: Parameters<typeof checkFreshness>[1] = (arr, code, message, extra) => arr.push(Object.assign({ code, message }, extra || {}));
  const w = checkFreshness({ exportedAt: new Date(Date.now() - 30 * 3600000).toISOString() }, push, warnings, {});
  const w0 = warnings[0];
  return w !== undefined && w.code === "stale-snapshot" && warnings.length === 1 && w0 !== undefined && w0.code === w.code && w0.message === w.message;
})());

// ---------- bootstrap ----------
console.log("bootstrap:");
const boot = bootstrap(dsCat);
check("component keyed by publish key + needs-review", !!boot.components.KEY_BTN && boot.components.KEY_BTN.status === "needs-review");
check("export PascalCased from multi-word name", must(bootstrap(catalog([{ key: "K", name: "Icon Button", type: "COMPONENT" }])).components.K, "component 'K'").code.export === "IconButton");
check("slash-namespaced name keeps namespace in export", must(bootstrap(catalog([{ key: "K", name: "Button/Primary/Danger", type: "COMPONENT" }])).components.K, "component 'K'").code.export === "ButtonPrimaryDanger");
check("VARIANT -> enum identity + default/omitDefault", anyProp(boot, "KEY_BTN", "Variant").kind === "enum" && enumProp(boot, "KEY_BTN", "Variant").values?.Primary === "Primary" && enumProp(boot, "KEY_BTN", "Variant").default === "Primary" && enumProp(boot, "KEY_BTN", "Variant").omitDefault === true);
check("BOOLEAN -> boolean prop with default+omitDefault", anyProp(boot, "KEY_BTN", "Disabled").kind === "boolean" && anyProp(boot, "KEY_BTN", "Disabled").codeProp === "disabled" && boolProp(boot, "KEY_BTN", "Disabled").default === false && boolProp(boot, "KEY_BTN", "Disabled").omitDefault === true);
check("TEXT named Label -> children", anyProp(boot, "KEY_BTN", "Label").codeProp === "children");
check("INSTANCE_SWAP -> instance slot", anyProp(boot, "KEY_BTN", "Icon").kind === "instance" && instanceProp(boot, "KEY_BTN", "Icon").slot === "icon");
check("bootstrap output passes validation", validateMap(boot).ok);
// catalog component with no name -> still valid output.
const a3 = bootstrap(malformed<ComponentsCatalog>({ components: [{ key: "K1", type: "COMPONENT" }] })); // no name, on purpose
check("missing component name -> figma.name is a string, output valid", typeof must(a3.components.K1, "component 'K1'").figma.name === "string" && validateMap(a3).ok);
// confirmed entry whose component is absent from catalog is PRESERVED, not dropped.
check("confirmed entry absent from catalog is preserved", "GONE" in bootstrap(dsCat, codeMap({ GONE: { figma: { key: "GONE", name: "Gone" }, code: { module: "@/hand", export: "Hand" }, status: "active" } })).components);
// re-run does NOT clobber in-progress needs-review edits; DOES add new props.
const a2existing = codeMap({ KEY_BTN: { figma: { key: "KEY_BTN", name: "Button" }, code: { module: "@/half/Done", export: "MyButton" }, status: "needs-review", props: { Variant: { kind: "enum", codeProp: "kind", values: { Primary: "solid" } } } } });
const a2 = bootstrap(dsCat, a2existing);
const a2KeyBtn = must(a2.components.KEY_BTN, "component 'KEY_BTN'");
check("needs-review human edits preserved (module/export/prop)", a2KeyBtn.code.module === "@/half/Done" && a2KeyBtn.code.export === "MyButton" && anyProp(a2, "KEY_BTN", "Variant").codeProp === "kind" && enumProp(a2, "KEY_BTN", "Variant").values?.Primary === "solid");
check("re-run adds newly-appeared props", a2KeyBtn.props?.Disabled !== undefined && a2KeyBtn.props?.Icon !== undefined);
// existing argument not mutated.
const a5existing = codeMap({ KEEP: { figma: { key: "KEEP", name: "Old" }, code: { module: "@/x", export: "X" }, status: "active" } });
const a5 = bootstrap(catalog([{ key: "KEEP", name: "New", id: "9:9", type: "COMPONENT" }]), a5existing);
const a5existingKeep = must(a5existing.components.KEEP, "component 'KEEP'");
const a5Keep = must(a5.components.KEEP, "component 'KEEP'");
check("existing arg not mutated; output refreshes metadata + keeps code", a5existingKeep.figma.name === "Old" && a5Keep.figma.name === "New" && a5Keep.code.export === "X");

// ================= regressions and closed test gaps =================
console.log("tokens — regressions:");
check("OPACITY-scoped FLOAT emits a percentage (Figma's 0–100 scale), never px", toCSS(tokens({ variables: [{ name: "opacity/disabled", type: "FLOAT", scopes: ["OPACITY"], values: { v: 50 } }] })).includes("--opacity-disabled: 50%;"));
check("dimension FLOAT still gets px", toCSS(tokens({ variables: [{ name: "gap/lg", type: "FLOAT", values: { v: 24 } }] })).includes("--gap-lg: 24px;"));
check("zero FLOAT stays unitless 0", toCSS(tokens({ variables: [{ name: "gap/none", type: "FLOAT", values: { v: 0 } }] })).includes("--gap-none: 0;"));
check("undefined-default value -> dedup vs emitted base (no duplicate override)", (toCSS(malformed<TokensDoc>({ collections: [{ name: "C", modes: ["Light", "Dark"], default: "Light", theming: true }], variables: [{ name: "bg", type: "COLOR", collection: "C", tier: "primitive", values: { Light: undefined, Dark: "#000000" } }] })).match(/#000000/g) || []).length === 1);
check("reverse-order group/leaf collision reported", lintTokens(tokens({ variables: [{ name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }, { name: "color", type: "COLOR", values: { v: "#111111" } }] })).some((w) => /collide/.test(w)));
check("reverse-order produces no illegal both-$value-and-child node", (() => { const d = toDTCG(tokens({ variables: [{ name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }, { name: "color", type: "COLOR", values: { v: "#111111" } }] })); const c = nodeAt(d, "color"); return !(c !== undefined && "$value" in c && "primary" in c); })());
check("malformed hex on COLOR reported by toDTCG", (() => { const w: string[] = []; toDTCG(tokens({ variables: [{ name: "brand", type: "COLOR", values: { v: "#12345" } }] }), w); return w.some((m) => /malformed hex/.test(m)); })());

console.log("drift — regressions:");
const reg3 = driftLint(codeMap({ SHARED: { figma: { id: "2:2", name: "Right" } } }), catalog([{ key: "SHARED", id: "1:1", name: "Wrong", type: "COMPONENT" }, { key: "K2", id: "2:2", name: "Right", type: "COMPONENT" }]));
check("explicit figma.id outranks map-key collision", !reg3.errors.length && !reg3.warnings.some((w) => w.code === "stale-name") && reg3.warnings.some((w) => w.code === "unmapped-component" && w.name === "Wrong"));
check("ambiguous base-name prop surfaced (not silently shadowed)", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { "Size#1": { kind: "enum", codeProp: "s", values: {} }, "Size#2": { kind: "enum", codeProp: "s2", values: {} } } } }), single()).warnings.some((w) => w.code === "ambiguous-prop"));
// [stale] an explicitly declared figma.key that no longer resolves is ORPHANED even when the map key
// coincidentally matches a DIFFERENT live component — no silent rebind (the whole point of the tool).
const f2 = driftLint(codeMap({ LIVE: { figma: { key: "DEAD", name: "Old" }, code: { module: "m", export: "E" } } }), catalog([{ key: "LIVE", id: "1:1", name: "Other", type: "COMPONENT" }]));
check("[stale] stale figma.key -> orphaned despite map-key collision (no rebind)", f2.errors.some((e) => e.code === "orphaned-entry" && e.mapKey === "LIVE") && f2.warnings.some((w) => w.code === "unmapped-component" && w.name === "Other") && !f2.warnings.some((w) => w.code === "stale-name"));
check("stale-name FIRES on rename (positive)", driftLint(codeMap({ K: { figma: { key: "K", name: "Old" } } }), catalog([{ key: "K", name: "New", type: "COMPONENT" }])).warnings.some((w) => w.code === "stale-name"));
check("uncovered-prop FIRES (positive)", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" } } }), single({ V: { type: "VARIANT", options: ["a"] } })).warnings.some((w) => w.code === "uncovered-prop"));
check("unmapped-variant-value FIRES (positive)", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { V: { kind: "enum", codeProp: "v", values: { a: "A" } } } } }), single({ V: { type: "VARIANT", options: ["a", "b"] } })).warnings.some((w) => w.code === "unmapped-variant-value"));

console.log("bootstrap — regressions:");
const a1ex = codeMap({ GONE: { figma: { key: "GONE", name: "Gone" }, code: { module: "@/hand", export: "Hand" }, status: "active", props: { X: { kind: "boolean", codeProp: "x" } } } });
const a1out = bootstrap(catalog([]), a1ex);
check("orphan preserved with FULL content (deep-equal) + valid", JSON.stringify(a1out.components.GONE) === JSON.stringify(a1ex.components.GONE) && validateMap(a1out).ok);
const r4out = bootstrap(catalog([{ key: "K", id: "1:1", name: "Btn", type: "COMPONENT" }]), codeMap({ "1:1": { figma: { id: "1:1", name: "Btn" }, code: { module: "@/kept", export: "Btn" }, status: "active" } }));
check("component gaining a key does NOT duplicate + keeps human code", Object.keys(r4out.components).length === 1 && !!r4out.components.K && !r4out.components["1:1"] && r4out.components.K.code.module === "@/kept");
check("prop whose Figma type changed is regenerated", must(bootstrap(catalog([{ key: "K", name: "B", type: "COMPONENT", props: { Size: { type: "BOOLEAN", default: false } } }]), codeMap({ K: { figma: { key: "K", name: "B" }, code: { module: "@/k", export: "B" }, status: "active", props: { Size: { kind: "enum", codeProp: "size", values: { a: "A" } } } } })).components.K, "component 'K'").props?.Size?.kind === "boolean");
check("stub with human export+prop edits preserved even under TODO module (no wholesale regen)", (() => { const n = bootstrap(catalog([{ key: "K", name: "Right", type: "COMPONENT", props: { V: { type: "VARIANT", options: ["Primary", "Secondary"] } } }]), codeMap({ K: { figma: { key: "K", name: "Wrong" }, code: { module: "TODO: import path", export: "MyName" }, status: "needs-review", props: { V: { kind: "enum", codeProp: "kind", values: { Primary: "solid" } } } } })); return must(n.components.K, "component 'K'").code.export === "MyName" && anyProp(n, "K", "V").codeProp === "kind" && enumProp(n, "K", "V").values?.Primary === "solid"; })());
check("added prop has correct kind+codeProp (not just presence)", anyProp(a2, "KEY_BTN", "Disabled").kind === "boolean" && anyProp(a2, "KEY_BTN", "Disabled").codeProp === "disabled");
check("non-label TEXT -> camelCase codeProp (not children)", must(bootstrap(catalog([{ key: "K", name: "B", type: "COMPONENT", props: { Placeholder: { type: "TEXT" } } }])).components.K, "component 'K'").props?.Placeholder?.codeProp === "placeholder");

console.log("validator — negative coverage:");
check("[V] version 2 rejected", !ok({ version: 2, components: {} }));
check("[V] code.targets numeric module rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E", targets: { web: { module: 5 } } } } } }));
check("[V] variantOverrides.code missing export rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, variantOverrides: [{ when: { T: "x" }, code: { module: "m" } }] } } }));
check("[V] figma.unstable non-bool rejected", !ok({ version: 1, components: { K: { figma: { name: "B", unstable: "yes" }, code: { module: "m", export: "E" } } } }));
check("[V] boolean omitDefault non-bool rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "boolean", codeProp: "p", omitDefault: "no" } } } } }));
check("[V] figmaFileKey non-string rejected", !ok({ version: 1, components: {}, figmaFileKey: 5 }));

// ================= mutation survivors closed =====
console.log("tokens — mutation survivors:");
check("[T-fw] FONT_WEIGHT-scoped FLOAT is unitless", toCSS(tokens({ variables: [{ name: "weight/bold", type: "FLOAT", scopes: ["FONT_WEIGHT"], values: { v: 700 } }] })).includes("--weight-bold: 700;"));
check("[T-ul] opts.unitless overrides px", toCSS(tokens({ variables: [{ name: "z/top", type: "FLOAT", values: { v: 100 } }] }), { unitless: new Set(["z/top"]) }).includes("--z-top: 100;"));
check("[T-sn] string-number FLOAT gets px", toCSS(tokens({ variables: [{ name: "s/x", type: "FLOAT", values: { v: "16" } }] })).includes("--s-x: 16px;"));
// [T-lh] Figma LineHeight is px|percent, NEVER a unitless multiplier -> px is the correct default
// (unitless `line-height: 24` would mean 24x font size). See UNITLESS_SCOPES comment.
check("[T-lh] LINE_HEIGHT-scoped FLOAT stays px (not unitless)", toCSS(tokens({ variables: [{ name: "text/lh", type: "FLOAT", scopes: ["LINE_HEIGHT"], values: { v: 24 } }] })).includes("--text-lh: 24px;"));
// [T-ls] letter-spacing bare number is invalid CSS -> px, not unitless.
check("[T-ls] LETTER_SPACING-scoped FLOAT stays px (bare number is invalid CSS)", toCSS(tokens({ variables: [{ name: "text/ls", type: "FLOAT", scopes: ["LETTER_SPACING"], values: { v: 0.5 } }] })).includes("--text-ls: 0.5px;"));
// ---------- [RD-*] real-data regressions: names/scopes taken from a live "Design System - NIMA"
// file (Figma starter plan). The mock fixtures above all set NARROW scopes, which hid these: real
// files leave Figma's default ALL_SCOPES in place, so the scopes-only unit rule emitted invalid CSS.
check("[RD-fw] ALL_SCOPES font-weight is unitless by NAME (was `500px`, invalid CSS)",
  toCSS(tokens({ variables: [{ name: "Font-Weight/medium", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 500 } }] })).includes("--Font-Weight-medium: 500;"));
check("[RD-op] ALL_SCOPES opacity is unitless by NAME (was `0.5px`, invalid CSS)",
  toCSS(tokens({ variables: [{ name: "Opacity/disabled", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 0.5 } }] })).includes("--Opacity-disabled: 0.5;"));
check("[RD-nos] the same holds when `scopes` is absent entirely",
  toCSS(tokens({ variables: [{ name: "font-weight/bold", type: "FLOAT", values: { v: 700 } }] })).includes("--font-weight-bold: 700;"));
// A font SIZE is a genuine length -> must keep px. Guards the name heuristic against over-reach.
check("[RD-fs] font-SIZE keeps px (heuristic does not over-match `font`)",
  toCSS(tokens({ variables: [{ name: "Font-Size/Text-sm", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 14 } }] })).includes("--Font-Size-Text-sm: 14px;"));
// A NARROWED scope stays authoritative — the name must never override an explicit designer signal.
check("[RD-narrow] explicit LINE_HEIGHT scope beats a name containing 'weight'",
  toCSS(tokens({ variables: [{ name: "weight/line-height", type: "FLOAT", scopes: ["LINE_HEIGHT"], values: { v: 24 } }] })).includes("--weight-line-height: 24px;"));
// The name heuristic is a GUESS, and every other rewrite in this file announces itself. A silent one
// is only visible as surprising CSS downstream.
check("[RD-say] a unit decided by NAME rather than scopes is reported by lintTokens",
  lintTokens(tokens({ variables: [{ name: "Opacity/disabled", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 0.5 } }] }))
    .some((w) => /Opacity\/disabled/.test(w) && /UNITLESS/.test(w)));
check("[RD-say] but a token the SCOPES decided is not reported (no noise on an explicit signal)",
  !lintTokens(tokens({ variables: [{ name: "opacity/disabled", type: "FLOAT", scopes: ["OPACITY"], values: { v: 0.5 } }] }))
    .some((w) => /UNITLESS/.test(w)));
// numberUnit short-circuits on opts.unitless BEFORE the name heuristic, so a token the caller named
// explicitly never reaches the guess. lintTokens has to take the same opts or it warns about a guess
// that was never made — and tells the caller to go fix it in Figma when they already fixed it here.
const nameGuessDs = tokens({ variables: [{ name: "Opacity/disabled", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 0.5 } }] });
const overrideOpts = { unitless: new Set(["Opacity/disabled"]) };
check("[RD-opts] a token overridden via opts.unitless is NOT reported as a name guess",
  !lintTokens(nameGuessDs, overrideOpts).some((w) => /UNITLESS/.test(w)));
check("[RD-opts] the same token IS reported when linted without those opts (the guess really did run)",
  lintTokens(nameGuessDs).some((w) => /UNITLESS/.test(w)));
// The override must not swallow the OTHER warnings for that token — it only pre-empts the unit guess.
check("[RD-opts] opts.unitless does not suppress unrelated warnings",
  lintTokens(tokens({ variables: [{ name: "(Space 3)", type: "FLOAT", values: { v: 12 } }] }), { unitless: new Set(["(Space 3)"]) })
    .some((w) => /illegal in a CSS custom property/.test(w)));
// Emitter and linter must agree about which tokens the heuristic touched — same opts, same verdict.
check("[RD-opts] emitter agrees: opts.unitless drops the px",
  toCSS(nameGuessDs, overrideOpts).includes("--Opacity-disabled: 0.5;"));
// `font[-_ ]?weight` used to be unanchored, so a font-weight SCALE — a multiplier, the one case in the
// family where the unit matters — also matched.
check("[RD-bound] 'font-weight-scale' is NOT swept up by the font-weight name rule",
  toCSS(tokens({ variables: [{ name: "font-weight-scale/lg", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 2 } }] })).includes("--font-weight-scale-lg: 2px;"));
// The matching unit is the `/`-delimited GROUP, so the property may sit in any segment...
check("[RD-bound] the property may be a trailing segment ('text/font-weight')",
  toCSS(tokens({ variables: [{ name: "text/font-weight", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 600 } }] })).includes("--text-font-weight: 600;"));
// ...but a segment that merely CONTAINS it names something else.
check("[RD-bound] 'opacity-curve' is a different property, not an opacity",
  toCSS(tokens({ variables: [{ name: "motion/opacity-curve", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 3 } }] })).includes("--motion-opacity-curve: 3px;"));
// [RD-fold] "(Space 3)" is a real variable name; parens are illegal in a custom property and were
// folded to `---Space-3-` SILENTLY, breaking the never-silent guarantee.
check("[RD-fold] illegal chars in a token name are folded",
  toCSS(tokens({ variables: [{ name: "(Space 3)", type: "FLOAT", values: { v: 12 } }] })).includes("---Space-3-: 12px;"));
check("[RD-fold] and the fold is REPORTED by lintTokens",
  lintTokens(tokens({ variables: [{ name: "(Space 3)", type: "FLOAT", values: { v: 12 } }] })).some((w) => /illegal in a CSS custom property/.test(w) && /\(Space 3\)/.test(w)));
// ---------- [RD2-*] real-data regression from a live "🎨 Design System" export (Material 3 typography
// scale): a "Body 2" FLOAT is scoped to FONT_WEIGHT *and* FONT_SIZE/LINE_HEIGHT/LETTER_SPACING/
// PARAGRAPH_SPACING/PARAGRAPH_INDENT at once. `.some()` let the single unitless scope win, emitting
// `--Body-2: 18;` (invalid as a font-size) with no hygiene warning at all.
check("[RD2-mixed] a scope mix of FONT_WEIGHT + length scopes keeps px (majority-length wins)",
  toCSS(tokens({ variables: [{ name: "Body 2", type: "FLOAT", scopes: ["FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT"], values: { v: 18 } }] })).includes("--Body-2: 18px;"));
check("[RD2-pure] a PURE FONT_WEIGHT+OPACITY mix (no length scope) is still unitless",
  toCSS(tokens({ variables: [{ name: "w/x", type: "FLOAT", scopes: ["FONT_WEIGHT", "OPACITY"], values: { v: 500 } }] })).includes("--w-x: 500;"));
check("[RD-fold] a legal name is NOT reported as folded",
  !lintTokens(tokens({ variables: [{ name: "Neutral/Grey 800", type: "COLOR", values: { v: "#262626" } }] })).some((w) => /illegal in a CSS custom property/.test(w)));

// [T-empty] no emittable vars -> no empty `:root {}` block.
check("[T-empty] empty variable set emits no `:root` block", toCSS({ variables: [] }) === "" && toCSS(tokens({ variables: [{ name: "", type: "COLOR", values: { v: "#abcdef" } }] })) === "");
// [T-str-safe] a STRING token cannot break out of its declaration/block: `;` and `}` are CSS-hex-escaped.
check("[T-str-safe] STRING `;`/`}` are CSS-escaped (no declaration breakout)", toCSS(tokens({ variables: [{ name: "content/x", type: "STRING", values: { v: "a;b}c" } }] })).includes("--content-x: a\\3b b\\7d c;"));
// [T-str-plain] an ordinary font stack (commas/spaces only) passes through byte-for-byte.
check("[T-str-plain] ordinary STRING (font stack) passes through unescaped", toCSS(tokens({ variables: [{ name: "font/sans", type: "STRING", values: { v: "Inter, system-ui, sans-serif" } }] })).includes("--font-sans: Inter, system-ui, sans-serif;"));
// [T-str-lint] never-silent: the escape is also reported by lintTokens.
check("[T-str-lint] escaped STRING reported by lintTokens", lintTokens(tokens({ variables: [{ name: "c/x", type: "STRING", values: { v: "a}b" } }] })).some((w) => /CSS-structural/.test(w)));

console.log("drift — mutation survivors:");
check("[clean] id-matched component NOT falsely unmapped", driftLint(codeMap({ "3:3": { figma: { name: "Card", id: "3:3" } } }), catalog([{ id: "3:3", name: "Card", type: "COMPONENT" }])).warnings.every((w) => w.code !== "unmapped-component"));
check("[multi-name] multi same-name orphan gives NO suggestedKey", (() => { const r = driftLint(codeMap({ DEAD: { figma: { key: "DEAD", name: "Button" } } }), catalog([{ key: "K1", name: "Button", type: "COMPONENT" }, { key: "K2", name: "Button", type: "COMPONENT" }])); const o = r.errors.find((e) => e.code === "orphaned-entry"); return o !== undefined && o.suggestedKey === undefined; })());
check("[kindless] map prop without kind -> no spurious kind-mismatch", driftLint(malformed<CodeConnectMap>({ version: 1, components: { K: { figma: { key: "K", name: "Btn" }, code: { module: "m", export: "E" }, props: { V: { codeProp: "v" } } } } }), single({ V: { type: "VARIANT", options: ["a"] } })).errors.every((e) => e.code !== "kind-mismatch"));
const collMap = codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { Size: { kind: "enum", codeProp: "s", values: { a: "A" } } } } });
const collA = catalog([{ key: "K", name: "B", type: "COMPONENT", props: { "Size": { type: "VARIANT", options: ["a"] }, "Size#2": { type: "BOOLEAN" } } }]);
const collB = catalog([{ key: "K", name: "B", type: "COMPONENT", props: { "Size#2": { type: "BOOLEAN" }, "Size": { type: "VARIANT", options: ["a"] } } }]);
check("[drift] colliding catalog base -> ambiguous warn, order-independent, no kind-mismatch", driftLint(collMap, collA).errors.every((e) => e.code !== "kind-mismatch") && driftLint(collMap, collB).errors.every((e) => e.code !== "kind-mismatch") && driftLint(collMap, collA).warnings.some((w) => w.code === "ambiguous-prop"));

console.log("validator — uncovered rules:");
check("[V] invalid status rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, status: "bogus" } } }));
check("[V] figma.key non-string rejected", !ok({ version: 1, components: { K: { figma: { name: "B", key: 5 }, code: { module: "m", export: "E" } } } }));
check("[V] enum values object value rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "enum", codeProp: "p", values: { a: {} } } } } } }));

console.log("bootstrap — mutation survivors:");
check("[boot-unstable] fresh unpublished component flagged unstable", must(bootstrap(catalog([{ id: "9:9", name: "Loose", type: "COMPONENT" }])).components["9:9"], "component '9:9'").figma.unstable === true);

// ================= more survivors closed + the map-side ambiguity symmetry ==========
console.log("tokens — more survivors:");
check("[default-not-first] collection default drives :root even when NOT the first-listed mode", toCSS(tokens({ collections: [{ name: "C", modes: ["Dark", "Light"], default: "Light" }], variables: [{ name: "bg", type: "COLOR", collection: "C", values: { Dark: "#000000", Light: "#ffffff" } }] })).includes("--bg: #ffffff;"));
check("[exact-channel] color channel pinned to 4dp (kills near()-masking of precision loss)", asColor(leafAt(toDTCG(tokens({ variables: [{ name: "c", type: "COLOR", values: { v: "#2563eb" } }] })), "c").$value).components[0] === 0.1451);

console.log("drift — map-side ambiguity:");
const mAmbCat = catalog([{ key: "K", name: "B", type: "COMPONENT", props: { Size: { type: "VARIANT", options: ["a"] } } }]);
check("[mapside] colliding MAP base -> order-independent, no false kind-mismatch",
  driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { "Size#1": { kind: "enum", codeProp: "s", values: { a: "A" } }, "Size#2": { kind: "boolean", codeProp: "s2" } } } }), mAmbCat).errors.every((e) => e.code !== "kind-mismatch") &&
  driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { "Size#2": { kind: "boolean", codeProp: "s2" }, "Size#1": { kind: "enum", codeProp: "s", values: { a: "A" } } } } }), mAmbCat).errors.every((e) => e.code !== "kind-mismatch"));
check("[unknown-type] Figma prop type outside the 4 kinds -> no fabricated kind-mismatch", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { N: { kind: "string", codeProp: "n" } } } }), malformed<ComponentsCatalog>({ components: [{ key: "K", name: "B", type: "COMPONENT", props: { N: { key: "N", type: "NUMBER" } } }] })).errors.every((e) => e.code !== "kind-mismatch"));
check("[empty-variant] option mapped to \"\" is NOT flagged unmapped", driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { V: { kind: "enum", codeProp: "v", values: { a: "" } } } } }), catalog([{ key: "K", name: "B", type: "COMPONENT", props: { V: { type: "VARIANT", options: ["a"] } } }])).warnings.every((w) => w.code !== "unmapped-variant-value"));
check("[nonarray-options] non-array options -> no-variant-options warning, no crash", (() => { try { return driftLint(codeMap({ K: { figma: { key: "K", name: "Btn" }, props: { V: { kind: "enum", codeProp: "v", values: { a: "A" } } } } }), malformed<ComponentsCatalog>({ components: [{ key: "K", name: "B", type: "COMPONENT", props: { V: { key: "V", type: "VARIANT", options: {} } } }] })).warnings.some((w) => w.code === "no-variant-options"); } catch (e) { return false; } })());
check("[cset-drift] unmapped COMPONENT_SET surfaced", driftLint(codeMap({}), catalog([{ key: "SET", name: "Btn", type: "COMPONENT_SET", props: { Variant: { type: "VARIANT", options: ["a"] } } }])).warnings.some((w) => w.code === "unmapped-component"));

console.log("validator — array-shaped fields:");
check("[V] components as array rejected", !ok({ version: 1, components: [] }));
check("[V] figma as array rejected", !ok({ version: 1, components: { K: { figma: ["x"], code: { module: "m", export: "E" } } } }));

console.log("bootstrap — more survivors:");
check("[cset-boot] COMPONENT_SET bootstrapped as enum", (() => { const b = bootstrap(catalog([{ key: "SET", name: "Btn", type: "COMPONENT_SET", props: { Variant: { type: "VARIANT", options: ["a", "b"] } } }])); return b.components.SET !== undefined && anyProp(b, "SET", "Variant").kind === "enum"; })());
check("[text-title] TEXT prop named Title -> children", must(bootstrap(catalog([{ key: "K", name: "B", type: "COMPONENT", props: { Title: { type: "TEXT" } } }])).components.K, "component 'K'").props?.Title?.codeProp === "children");
check("[boot-bool-coerce] non-boolean BOOLEAN default coerced to real boolean + valid", (() => { const m = bootstrap(malformed<ComponentsCatalog>({ components: [{ key: "K", name: "B", type: "COMPONENT", props: { D: { key: "D", type: "BOOLEAN", default: 1 } } }] })); return boolProp(m, "K", "D").default === true && validateMap(m).ok; })());
check("[boot-id-refresh] preserve path refreshes figma.id from catalog", must(bootstrap(catalog([{ key: "K", id: "5:5", name: "B", type: "COMPONENT" }]), codeMap({ K: { figma: { key: "K", name: "B" }, code: { module: "@/k", export: "B" }, status: "active" } })).components.K, "component 'K'").figma.id === "5:5");
check("[boot-unstable-preserve] preserve path flags unpublished as unstable", must(bootstrap(catalog([{ id: "7:7", name: "Loose", type: "COMPONENT" }]), codeMap({ "7:7": { figma: { id: "7:7", name: "Loose" }, code: { module: "@/k", export: "L" }, status: "active" } })).components["7:7"], "component '7:7'").figma.unstable === true);

console.log("security — reserved-key hardening:");
// Token maps are semi-trusted third-party dumps; a name like "__proto__/x" must NOT pollute Object.prototype.
check("[sec-proto-no-pollute] __proto__ token name does not mutate Object.prototype", (() => {
  toDTCG(tokens({ variables: [{ name: "__proto__/polluted", type: "COLOR", values: { v: "#112233" } }] }), []);
  return bag({}).polluted === undefined && !("polluted" in {});
})());
check("[sec-proto-warns] reserved-key token is skipped with a warning", (() => {
  const w: string[] = []; const root = toDTCG(tokens({ variables: [{ name: "constructor/x", type: "COLOR", values: { v: "#112233" } }] }), w);
  return w.some((m) => /reserved key/.test(m)) && !Object.hasOwn(root, "constructor") && nodeAt(root, "x") === undefined;
})());
check("[sec-boot-proto-key] component keyed '__proto__' is kept, not dropped", (() => {
  const m = bootstrap(catalog([{ key: "__proto__", name: "Weird", type: "COMPONENT" }]));
  return Object.keys(m.components).includes("__proto__") && must(m.components["__proto__"], "component '__proto__'").figma.name === "Weird";
})());
check("[sec-boot-figma-proto] existing entry.figma with an own '__proto__' property does not repoint the merged figma object", (() => {
  // JSON.parse (unlike an object literal) creates a real own "__proto__" data property — exactly what a
  // hand-edited or hostile map on disk can carry. bootstrap() must not let Object.assign turn that into
  // a repointed prototype for the merged figma object.
  const existingRaw: unknown = JSON.parse('{"version":1,"components":{"K":{"figma":{"key":"K","name":"Old","__proto__":{"polluted":1}},"code":{"module":"@/k","export":"B"},"status":"active"}}}');
  const existing = malformed<CodeConnectMap>(existingRaw);
  const m = bootstrap(catalog([{ key: "K", name: "New", type: "COMPONENT" }]), existing);
  const figma: unknown = must(m.components.K, "component 'K'").figma;
  return Object.getPrototypeOf(figma) === Object.prototype && !("polluted" in (figma as object)) && JSON.stringify(figma) === JSON.stringify({ key: "K", name: "New" });
})());
check("[sec-boot-prop-proto-key] catalog prop named '__proto__' does not corrupt props", (() => {
  // Computed key syntax (unlike a quoted string literal key) creates a real own "__proto__" property
  // instead of setting the object literal's own prototype — the same shape JSON.parse produces. Built
  // via malformed()+a raw literal (not the catalog()/component() fixture helpers, which themselves copy
  // props through a plain `{}` and would trip the same hazard before bootstrap() is even reached).
  const defs = { ["__proto__"]: { key: "__proto__", type: "BOOLEAN" } as ComponentPropDef };
  const cat = malformed<ComponentsCatalog>({ components: [{ key: "K", name: "B", type: "COMPONENT", props: defs }] });
  const m = bootstrap(cat);
  const props: unknown = must(m.components.K, "component 'K'").props;
  return props !== undefined && Object.keys(props as object).includes("__proto__") && (props as Record<string, { kind?: string }>)["__proto__"]?.kind === "boolean";
})());
check("[boot-safeassign-no-figma] a prior entry lacking `figma` does not throw (safeAssign tolerates undefined/null sources like Object.assign)", (() => {
  // MapEntry.figma is typed as required, but a hand-edited/hostile map on disk (JSON.parse output,
  // never runtime-checked here) can genuinely lack it. safeAssign({}, entry.figma, {...}) must not
  // throw when entry.figma is undefined — it should behave like Object.assign and just skip it.
  const existingRaw: unknown = JSON.parse('{"version":1,"components":{"K":{"code":{"module":"@/k","export":"B"},"status":"active"}}}');
  const existing = malformed<CodeConnectMap>(existingRaw);
  const m = bootstrap(catalog([{ key: "K", name: "New", type: "COMPONENT" }]), existing);
  return must(m.components.K, "component 'K'").figma.name === "New";
})());
check("[sec-lint-proto-key] prop named '__proto__' is compared, not silently skipped", (() => {
  // Maps load via JSON.parse, which (unlike an object literal) creates a real own "__proto__" key.
  // A map prop '__proto__' absent on the Figma component must surface as stale-prop, not be skipped.
  const map: unknown = JSON.parse('{"version":1,"components":{"K":{"figma":{"key":"K","name":"B"},"code":{"module":"@/k","export":"B"},"props":{"__proto__":{"kind":"boolean","codeProp":"x"}}}}}');
  if (!isCodeConnectMap(map)) return false;
  const cat = catalog([{ key: "K", name: "B", type: "COMPONENT", props: {} }]);
  const res = driftLint(map, cat);
  return res.errors.some((e) => e.code === "stale-prop" && e.prop === "__proto__");
})());

console.log("validator — prototype-named prop kinds:");
// KEYS.prop is keyed by an UNTRUSTED `kind` value. On a plain object literal, kind:"constructor"
// resolved to an inherited Object.prototype member — truthy, then `.includes` threw, turning a
// validation error into an uncaught TypeError and breaking "never throws on bad data".
const propMap = (kind: unknown) => ({ version: 1, components: { B: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { p: { kind, codeProp: "x" } } } } });
for (const kind of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
  check(`[V-proto-kind] kind '${kind}' reports an error instead of throwing`, (() => {
    let res;
    try { res = validateMap(propMap(kind)); } catch (e) { return false; }
    return res.ok === false && res.errors.some((e) => /must be one of/.test(e.message) && e.path.endsWith(".kind"));
  })());
}
check("[V-kind-nonstring] non-string kind reports an error instead of throwing", (() => {
  let res; try { res = validateMap(propMap(42)); } catch (e) { return false; }
  return res.ok === false;
})());
check("[V-valid-kind-still-ok] a genuine kind still validates", validateMap(propMap("boolean")).ok === true);

console.log("security — CSS breakout in STRING tokens:");
// A STRING token value can escape its declaration three ways; all must be neutralized AND reported.
const strTok = (v: string) => tokens({ collections: [{ name: "C", modes: ["light"], default: "light" }], variables: [
  { name: "t", type: "STRING", collection: "C", values: { light: v } },
  { name: "after", type: "COLOR", collection: "C", values: { light: "#2563eb" } }] });
const survives = (v: string) => toCSS(strTok(v)).includes("--after");
const unclosedComment = (v: string) => { const c = toCSS(strTok(v)); return (c.match(/\/\*/g) || []).length !== (c.match(/\*\//g) || []).length; };
for (const [label, v] of [["comment-open", "Inter /*"], ["comment-close", "a */ b"], ["semicolon", "a;color:red"], ["brace", "a}"], ["unbalanced-paren", "cubic-bezier(0.4,0,0.2,1"], ["unbalanced-quote", '"Inter, sans-serif']] satisfies [string, string][]) {
  check(`[sec-css-${label}] token after the payload still survives`, survives(v) && !unclosedComment(v));
  check(`[sec-css-${label}] rewrite is reported by lintTokens`, lintTokens(strTok(v)).some((w) => /CSS-structural/.test(w)));
}
// Legitimate values contain parens/quotes/slashes and must pass through byte-for-byte — an escaper
// that mangled these would break every easing token and font stack in a real design system.
for (const [label, v] of [["easing", "cubic-bezier(0.4, 0, 0.2, 1)"], ["font-stack", '"Inter", sans-serif'], ["url", "url(/img.png)"], ["math", "2 * 4 / 2"]] satisfies [string, string][]) {
  check(`[css-legit-${label}] passes through unescaped`, toCSS(strTok(v)).includes(`--t: ${v};`));
  check(`[css-legit-${label}] not reported as rewritten`, !lintTokens(strTok(v)).some((w) => /CSS-structural/.test(w)));
}

console.log("security — reserved-key and breakout hardening in MODE NAMES:");
// Mode names are free-form designer strings (the Plugin API documents no restriction on
// addMode/renameMode) and reach the emitters through JSON.parse — which, unlike an object literal,
// creates a REAL own "__proto__" key. Both emitters key objects by mode name, so both were exposed:
// toCSS threw an uncaught TypeError (perMode.__proto__ is Object.prototype, which has no .push) and
// toDTCG silently dropped the mode (assigning to __proto__ sets the prototype, not an own key).
const modeDs = (mode: string): TokensDoc => {
  const parsed: unknown = JSON.parse(JSON.stringify({
    collections: [{ name: "Theme", modes: ["Light", mode], default: "Light", theming: true }],
    variables: [{ name: "color/bg", type: "COLOR", collection: "Theme", tier: "primitive", values: { Light: "#ffffff", [mode]: "#000000" } }],
  }));
  return must(isTokensDoc(parsed) ? parsed : null, "the parsed fixture to be a token doc");
};
for (const mode of ["__proto__", "constructor", "prototype", "toString"]) {
  const ds = modeDs(mode);
  check(`[sec-mode-${mode}] toCSS does not throw`, (() => { try { toCSS(ds); return true; } catch (e) { return false; } })());
  check(`[sec-mode-${mode}] the mode's override block is emitted`, (() => {
    try { return toCSS(ds).includes("--color-bg: #000000;"); } catch (e) { return false; }
  })());
  check(`[sec-mode-${mode}] toDTCG keeps the mode in $extensions`, (() => {
    const modes = modesOf(leafAt(toDTCG(ds), "color.bg"));
    // Round-trip through JSON: a prototype-assigned key would vanish here even if it read back live.
    const round: unknown = JSON.parse(JSON.stringify(modes));
    return isJsonObject(round) && Object.keys(round).includes(mode);
  })());
  check(`[sec-mode-${mode}] Object.prototype was not mutated`, bag({}).Light === undefined);
}
// A mode name also lands inside an attribute selector: [data-theme="<mode>"]. A quote or backslash
// closes that string early and injects arbitrary selectors/declarations — the same breakout class
// the STRING-token escaper guards, in a different syntactic context.
const quoteMode = 'dark"] * { display: none } [x="';
const quoteCss = toCSS(modeDs(quoteMode));
check("[sec-mode-quote] quote in a mode name cannot close the attribute selector", !quoteCss.includes('dark"]'));
// The payload TEXT still appears — inert, inside the quoted attribute value — so asserting its
// absence would be wrong. What matters is that it stays inside that string: the selector must carry
// exactly two raw `"` (its own delimiters), with the injected one hex-escaped to `\22 `. Unescaped,
// this line would hold four, and the `* { display: none }` between them would be a live rule.
const quoteSelector = (quoteCss.match(/^\[data-theme=.*$/m) || [""])[0];
check("[sec-mode-quote] payload stays inside the quoted attribute value", (quoteSelector.match(/"/g) || []).length === 2 && quoteSelector.includes("\\22 "));
check("[sec-mode-quote] the escaped selector still carries its declarations", quoteCss.includes("--color-bg: #000000;"));
check("[sec-mode-quote] rewrite is reported by lintTokens", lintTokens(modeDs(quoteMode)).some((w) => /escaped in its tokens\.css selector/.test(w)));
check("[css-legit-mode] an ordinary mode name is NOT escaped", toCSS(modeDs("Dark")).includes('[data-theme="Dark"]'));
check("[css-legit-mode] and is not reported as rewritten", !lintTokens(modeDs("Dark")).some((w) => /escaped in its tokens\.css selector/.test(w)));

// ---------- duplicate names: identical twins collapse, different variables are ALL kept -------
// THREE variables called "Schemes/On Primary" with distinct keys put the identical
// declaration in :root three times and once more per mode block — 22 copies. Those resolve the same in
// every mode, so they are ONE declaration. The other half: two `Space 4` with
// distinct keys and DIFFERENT values (24 vs 16), where "last definition wins" shipped the wrong one.
// Those must BOTH be emitted, each under its own name, and never by input order.
(() => {
  const twins = tokens({
    collections: [{ name: "M3", modes: ["Light", "Dark"], default: "Light" }, { name: "material-theme", modes: ["Light", "Dark"], default: "Light" }],
    variables: [
      { name: "Schemes/On Primary", key: "aaa1", type: "COLOR", collection: "M3", values: { Light: "#ffffff", Dark: "#111111" } },
      { name: "Schemes/On Primary", key: "bbb2", type: "COLOR", collection: "material-theme", values: { Light: "#ffffff", Dark: "#111111" } },
      { name: "Schemes/On Primary", key: "ccc3", type: "COLOR", collection: "material-theme", values: { Light: "#ffffff", Dark: "#111111" } },
    ],
  });
  const css = toCSS(twins);
  const root = (css.match(/:root \{([\s\S]*?)\}/) || ["", ""])[1] ?? "";
  check("[dup-css] three IDENTICAL variables sharing a name emit ONE :root declaration, not three",
    (root.match(/--Schemes-On-Primary/g) || []).length === 1);
  // both collections DECLARE "Dark", so its blocks are scoped per collection; the twins still fold
  // onto ONE declaration across all of them (the canonical record's collection carries it).
  const dark = [...css.matchAll(/\[data-theme[^\]]*="Dark"\] \{([\s\S]*?)\}/g)].map((m) => m[1] ?? "").join("\n");
  check("[dup-css] and one per mode block too", (dark.match(/--Schemes-On-Primary/g) || []).length === 1);
  check("[dup-css] the identical twins are reported as such (naming the keys), not silently swallowed",
    lintTokens(twins).some((w) => /share the name 'Schemes\/On Primary'.*resolve identically in every mode — emitted ONCE/.test(w) && /aaa1/.test(w) && /ccc3/.test(w)));

  // The two real `Space 4` rows of a field export's design/export/variables.json (keys, values, scopes verbatim).
  const space4 = (order: boolean) => {
    const a: VariableInput = { name: "Space 4", key: "e26d506ea43ae0582896add59d9e04156fb3f6d5", type: "FLOAT", collection: "Spacing", scopes: ["WIDTH_HEIGHT", "GAP"], values: { "Mode 1": 24 } };
    const b: VariableInput = { name: "Space 4", key: "64928e3a5f094c0d9a2c916f50b98ff37c789882", type: "FLOAT", collection: "Spacing", scopes: ["GAP"], values: { Desktop: 16, Tablet: 8, Mobile: 8 } };
    return tokens({ collections: [{ name: "Spacing", modes: ["Mode 1"], default: "Mode 1" }, { name: "Spacing", modes: ["Desktop", "Tablet", "Mobile"], default: "Desktop" }], variables: order ? [a, b] : [b, a] });
  };
  const c1 = toCSS(space4(true)), c2 = toCSS(space4(false));
  check("[dup-css] two DIFFERENT variables sharing a name are both emitted, each carrying its key",
    /--Space-4-e26d506e: 24px;/.test(c1) && /--Space-4-64928e3a: 16px;/.test(c1) && !/--Space-4:/.test(c1));
  check("[dup-css] and input ORDER changes nothing about which name each value gets",
    /--Space-4-e26d506e: 24px;/.test(c2) && /--Space-4-64928e3a: 16px;/.test(c2));
  const w = lintTokens(space4(true));
  check("[dup-css] the warning names BOTH keys and BOTH values, and no longer claims a 'later definition wins'",
    w.some((m) => /e26d506e/.test(m) && /64928e3a/.test(m) && /"Mode 1":24/.test(m) && /"Desktop":16/.test(m) && /resolve DIFFERENTLY/.test(m)) && !w.some((m) => /later definition wins/.test(m)));
  const d = toDTCG(space4(false));
  check("[dup-dtcg] tokens.dtcg.json keeps both too, with the Figma key under $extensions",
    !!d["Space-4-e26d506e"] && asDimension(leafAt(d, "Space-4-e26d506e").$value).value === 24 && asDimension(leafAt(d, "Space-4-64928e3a").$value).value === 16
    && figmaExt(leafAt(d, "Space-4-e26d506e")).key === "e26d506ea43ae0582896add59d9e04156fb3f6d5");
  check("[dup-css] distinct names are untouched — the dedup keys on the emitted property, not on being a dup",
    (toCSS(tokens({ collections: [{ name: "A", modes: ["M"], default: "M" }], variables: [
      { name: "a/one", type: "COLOR", collection: "A", values: { M: "#111" } },
      { name: "a/two", type: "COLOR", collection: "A", values: { M: "#222" } }] })).match(/--a-/g) || []).length === 2);
})();

// ---------- --web tailwind: the web counterpart of --native ----------------------
(() => {
  const twDs = tokens({
    collections: [{ name: "Theme", modes: ["Light", "Dark"], default: "Light" }],
    variables: [
      { name: "gray/900", type: "COLOR", collection: "Theme", values: { Light: "#121319", Dark: "#121319" } },
      { name: "color/primary", type: "COLOR", collection: "Theme", values: { Light: "#dec9ff", Dark: "#381e72" } },
      { name: "bg/side-menu", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "gray/900" }, Dark: { aliasOf: "gray/900" } } },
      { name: "space/md", type: "FLOAT", collection: "Theme", values: { Light: 16, Dark: 16 } },
      { name: "radius/card", type: "FLOAT", collection: "Theme", scopes: ["CORNER_RADIUS"], values: { Light: 12, Dark: 12 } },
      { name: "text/body", type: "FLOAT", collection: "Theme", scopes: ["FONT_SIZE"], values: { Light: 14, Dark: 14 } },
      { name: "opacity/disabled", type: "FLOAT", collection: "Theme", scopes: ["OPACITY"], values: { Light: 50, Dark: 50 } },
    ],
  });
  const tw = toTailwind(twDs);
  // Tailwind v4 generates a utility from the NAMESPACE, so filing a token under the wrong one gives
  // a custom property no class can reach. Each kind must land under the namespace that earns it.
  check("[tw] colors -> --color-figma-*, spacing -> --spacing-figma-*, radius -> --radius-figma-*, font size -> --text-figma-*",
    /--color-figma-color-primary: #dec9ff;/.test(tw.text) && /--spacing-figma-space-md: 16px;/.test(tw.text)
    && /--radius-figma-radius-card: 12px;/.test(tw.text) && /--text-figma-text-body: 14px;/.test(tw.text));
  check("[tw] a unitless FLOAT matches no namespace — emitted as a plain --figma-* property rather than filed wrongly or dropped",
    /\n {2}--figma-opacity-disabled: 50%;/.test(tw.text) && !/--spacing-figma-opacity-disabled/.test(tw.text));
  check("[tw] an alias points at its TARGET's namespaced name, not the referrer's and not tokens.css's",
    /--color-figma-bg-side-menu: var\(--color-figma-gray-900\);/.test(tw.text));
  check("[tw] the file imports tailwind and opens a @theme block", /^@import "tailwindcss";/.test(tw.text) && /@theme \{/.test(tw.text));
  // @theme cannot be nested in a selector, so non-default modes reassign the same properties outside it.
  const modeBlock = (tw.text.match(/\[data-theme="Dark"\] \{([\s\S]*?)\}/) || ["", ""])[1] ?? "";
  check("[tw] a non-default mode reassigns the same custom properties OUTSIDE @theme",
    /--color-figma-color-primary: #381e72;/.test(modeBlock) && tw.text.indexOf("@theme") < tw.text.indexOf('[data-theme="Dark"]'));
  check("[tw] a value identical across modes is not repeated in the mode block", !/--spacing-figma-space-md/.test(modeBlock));
  check("[tw] counts distinguish tokens emitted from tokens that actually generate a utility",
    tw.tokens === 7 && tw.utilities === 6);
  check("[tw] the SAME variable listed twice is one declaration (its last record)", (() => {
    const d = toTailwind(tokens({ collections: [{ name: "A", modes: ["M"], default: "M" }], variables: [
      { name: "on/primary", key: "k1", type: "COLOR", collection: "A", values: { M: "#fff" } },
      { name: "on/primary", key: "k1", type: "COLOR", collection: "A", values: { M: "#000" } }] }));
    return (d.text.match(/--color-figma-on-primary:/g) || []).length === 1 && /#000000/.test(d.text) && !d.warnings.length;
  })());
  // `Space 3` (16) and `(Space 3)` (12) are different NAMES that only collide after
  // slugging, and the theme must not silently keep 12. Collisions are
  // detected on the EMITTED name, and the name spelled exactly as the identifier keeps it.
  check("[tw] two names that fold onto one Tailwind name are both emitted, and the run SAYS so", (() => {
    const d = toTailwind(tokens({ collections: [{ name: "Spacing", modes: ["Mode 1"], default: "Mode 1" }], variables: [
      { name: "(Space 3)", key: "a96c665bae7a1989c41dd71440cfd9b0a0c0ba4f", type: "FLOAT", collection: "Spacing", scopes: ["GAP"], values: { "Mode 1": 12 } },
      { name: "Space 3", key: "a9aa73e78e34066545c67621b5f7aef9ab89a4f1", type: "FLOAT", collection: "Spacing", scopes: ["GAP"], values: { "Mode 1": 16 } }] }));
    return /--spacing-figma-space-3: 16px;/.test(d.text) && /--spacing-figma-space-3-a96c665b: 12px;/.test(d.text)
      && d.warnings.some((w) => /'Space 3'/.test(w) && /'\(Space 3\)'/.test(w) && /a96c665b/.test(w) && /a9aa73e7/.test(w));
  })());
  // livetest-3 #183: `--radius-xl: 16px` in @theme REPLACED Tailwind's own rounded-xl (12px).
  check("[tw] no generated variable can shadow Tailwind's own scale — radius XL/L/S/Full land under figma- (livetest-3 #183)", (() => {
    const d = toTailwind(tokens({ collections: [{ name: "Border Radius", modes: ["Mode 1"], default: "Mode 1" }], variables: ["S", "L", "XL", "Full"].map((n, i) => (
      { name: n, key: "r" + i, type: "FLOAT", collection: "Border Radius", scopes: ["CORNER_RADIUS", "FONT_VARIATIONS"], values: { "Mode 1": must([4, 12, 16, 1000000000][i], `radius value at index ${i}`) } })) }));
    return !/^ {2}--radius-(xl|l|s|full):/m.test(d.text) && /--radius-figma-xl: 16px;/.test(d.text) && /--radius-figma-l: 12px;/.test(d.text);
  })());
  check("[tw] Figma's 1e9 'fully rounded' sentinel is emitted as 9999px, never as 1000000000px", (() => {
    const ds = tokens({ collections: [{ name: "Border Radius", modes: ["Mode 1"], default: "Mode 1" }], variables: [
      { name: "Full", key: "ba82", type: "FLOAT", collection: "Border Radius", scopes: ["CORNER_RADIUS"], values: { "Mode 1": 1000000000 } }] });
    const t = toTailwind(ds).text, c = toCSS(ds), j = toDTCG(ds);
    return /--radius-figma-full: 9999px;/.test(t) && /--Full: 9999px;/.test(c) && !/1000000000/.test(t + c)
      && asDimension(leafAt(j, "Full").$value).value === 9999 && figmaExt(leafAt(j, "Full")).sentinel?.figmaValue === 1000000000;
  })());
  check("[tw] a mode name cannot break out of its attribute selector (same escaping toCSS uses)",
    !/dark"\]/.test(toTailwind(tokens({ collections: [{ name: "A", modes: ["Light", 'dark"] * { display: none } [x="'], default: "Light" }],
      variables: [{ name: "c", type: "COLOR", collection: "A", values: { Light: "#fff", 'dark"] * { display: none } [x="': "#000" } }] })).text));
})();

// ---------- non-default modes are scoped PER COLLECTION when a mode name is shared ----------
// Figma selects a mode per collection; one `[data-theme="Dark"]` per mode NAME flipped every collection
// with a "Dark" at once. Real shape: collections carry name/modes/default/theming/key; two collections may
// share a NAME (a single-mode "Spacing" and a multi-mode "Spacing" in the same export) — told apart by key.
(() => {
  const KB = "b1a2c3d4e5f60718293a4b5c6d7e8f9012345678", KS = "5a5b5c5d5e5f60718293a4b5c6d7e8f9012345678";
  const K1 = "aaaaaaaa11112222333344445555666677778888", K2 = "bbbbbbbb11112222333344445555666677778888";
  const clash = tokens({
    collections: [
      { name: "Brand", modes: ["Light", "Dark"], default: "Light", theming: true, key: KB },
      { name: "Surface", modes: ["Light", "Dark"], default: "Light", theming: true, key: KS },
      { name: "Contrast", modes: ["Normal", "High"], default: "Normal", theming: true, key: "cccc0000111122223333444455556666777788ff" },
      { name: "Spacing", modes: ["Regular", "Compact"], default: "Regular", theming: false, key: K1 },
      { name: "Spacing", modes: ["Regular", "Compact", "Wide"], default: "Regular", theming: false, key: K2 },
    ],
    variables: [
      { name: "Brand/Primary", type: "COLOR", collection: "Brand", values: { Light: "#112233", Dark: "#aabbcc" }, scopes: ["ALL_FILLS"], key: "v1" },
      { name: "Surface/Page", type: "COLOR", collection: "Surface", values: { Light: "#ffffff", Dark: "#000000" }, scopes: ["FRAME_FILL"], key: "v2" },
      { name: "Contrast/Ink", type: "COLOR", collection: "Contrast", values: { Normal: "#333333", High: "#000000" }, scopes: ["TEXT_FILL"], key: "v3" },
      { name: "Gap/Card", type: "FLOAT", collection: "Spacing", values: { Regular: 16, Compact: 8 }, scopes: ["GAP"], key: "v4" },
      { name: "Gap/Page", type: "FLOAT", collection: "Spacing", values: { Regular: 24, Compact: 12, Wide: 32 }, scopes: ["GAP"], key: "v5" },
    ],
  });
  const css = toCSS(clash), tw = toTailwind(clash), lint = lintTokens(clash);
  const block = (text: string, sel: string) => (text.split("\n" + sel + " {\n")[1] || "").split("\n}")[0] ?? "";
  check("a mode only ONE collection has a block for keeps [data-theme=\"<mode>\"] (unchanged)",
    /--Contrast-Ink: #000000;/.test(block(css, '[data-theme="High"]')));
  check("'Dark' in two collections: each gets its own [data-theme-<collection>] block, no shared [data-theme=\"Dark\"]",
    /--Brand-Primary: #aabbcc;/.test(block(css, '[data-theme-brand="Dark"]')) && !/Surface/.test(block(css, '[data-theme-brand="Dark"]'))
    && /--Surface-Page: #000000;/.test(block(css, '[data-theme-surface="Dark"]')) && !css.includes('[data-theme="Dark"]'));
  check("ONE warning per clashing mode name, naming the collections and the attributes to set",
    lint.filter((w) => /^mode 'Dark' exists in 2 collections \(Brand, Surface\)/.test(w) && w.includes('data-theme-brand="Dark" / data-theme-surface="Dark"')).length === 1
    && !lint.some((w) => /^mode 'High'/.test(w)));
  check("two collections that share a NAME are told apart by the first 8 hex of their key",
    /--Gap-Card: 8px;/.test(block(css, '[data-theme-spacing-aaaaaaaa="Compact"]')) && /--Gap-Page: 12px;/.test(block(css, '[data-theme-spacing-bbbbbbbb="Compact"]'))
    && /--Gap-Page: 32px;/.test(block(css, '[data-theme="Wide"]')));
  const selectors = (text: string) => text.split("\n").filter((l) => /^\[data-theme/.test(l)).join("\n");
  check("tokens.css and theme.css use the same selectors for the same blocks", selectors(css) !== "" && selectors(css) === selectors(tw.text));
  check("toTailwind (standalone) carries the same warning", tw.warnings.some((w) => /^mode 'Dark' exists in 2 collections/.test(w)));
  const hostile = tokens({ collections: [{ name: 'X"] * {} [y', modes: ["L", "D"], default: "L", key: KB }, { name: "Other", modes: ["L", "D"], default: "L", key: KS }],
    variables: [{ name: "a", type: "COLOR", collection: 'X"] * {} [y', values: { L: "#fff", D: "#000" } }, { name: "b", type: "COLOR", collection: "Other", values: { L: "#fff", D: "#000" } }] });
  check("the attribute NAME is only [a-z0-9-] whatever the collection is called", /^\[data-theme-x-y="D"\] \{$/m.test(toCSS(hostile)) && !/\[data-theme-[^=]*[^a-z0-9=-][^=]*=/.test(toCSS(hostile)));
  const seen: string[] = [];
  toCSS(clash, { selector: (m, sc) => { seen.push(`${sc.collection}:${sc.attribute}:${m}`); return `.theme-${m}`; } });
  check("opts.selector(mode, scope) gets the collection and the attribute it would have used",
    seen.includes("Brand:data-theme-brand:Dark") && seen.includes("Contrast:data-theme:High"));
  const noColl = tokens({ collections: [{ name: "Brand", modes: ["Light", "Dark"], default: "Light", key: KB }],
    variables: [{ name: "Loose", type: "COLOR", values: { Light: "#fff", Dark: "#000" } }, { name: "Brand/Primary", type: "COLOR", collection: "Brand", values: { Light: "#fff", Dark: "#111" } }] });
  check("a variable with no collection is its own group (scoped when it clashes)",
    /--Loose: #000000;/.test(block(toCSS(noColl), '[data-theme-no-collection="Dark"]')) && /--Brand-Primary: #111111;/.test(block(toCSS(noColl), '[data-theme-brand="Dark"]')));
})();

// ---------- sharing is DECLARED modes; font families quoted in both files; alias chains kept ----------
(() => {
  const declaredOnly = tokens({
    collections: [{ name: "Brand", modes: ["Light", "Dark"], default: "Light", theming: true, key: "b1a2c3d4e5f60718293a4b5c6d7e8f9012345678" },
      { name: "Surface", modes: ["Light", "Dark"], default: "Light", theming: true, key: "5a5b5c5d5e5f60718293a4b5c6d7e8f9012345678" }],
    variables: [
      { name: "Brand/Primary", type: "COLOR", collection: "Brand", values: { Light: "#112233", Dark: "#aabbcc" }, key: "v1" },
      { name: "Surface/Page", type: "COLOR", collection: "Surface", values: { Light: "#ffffff", Dark: "#ffffff" }, key: "v2" }, // Dark = Light today
    ],
  });
  const c = toCSS(declaredOnly);
  check("[declared] two collections DECLARE 'Dark' but only one has a differing value: still scoped per collection (stable across a value edit)",
    c.includes('[data-theme-brand="Dark"] {') && !c.includes('[data-theme="Dark"]') && toTailwind(declaredOnly).text.includes('[data-theme-brand="Dark"] {'));
  const fonts = tokens({ collections: [{ name: "Type", modes: ["Mode 1"], default: "Mode 1" }], variables: [
    { name: "Heading", type: "STRING", collection: "Type", values: { "Mode 1": "Inter Display 2" }, scopes: ["FONT_FAMILY"] },
    { name: "Font Family/Body", type: "STRING", collection: "Type", values: { "Mode 1": "Open Sans" }, scopes: ["ALL_SCOPES"] },
    { name: "Label", type: "STRING", collection: "Type", values: { "Mode 1": "Semi Bold" }, scopes: ["ALL_SCOPES"] }] });
  const fc = toCSS(fonts), ft = toTailwind(fonts).text;
  check("[css] tokens.css quotes a font-family STRING like theme.css does (FONT_FAMILY scope, name fallback); other strings stay as they were",
    fc.includes('  --Heading: "Inter Display 2";') && ft.includes('  --font-figma-heading: "Inter Display 2";')
    && fc.includes('  --Font-Family-Body: "Open Sans";') && ft.includes('  --font-figma-font-family-body: "Open Sans";') && fc.includes("  --Label: Semi Bold;"));
  const chain = tokens({ collections: [{ name: "Type", modes: ["M"], default: "M" }], variables: [
    { name: "Primitive/Inter", type: "STRING", collection: "Type", values: { M: "Inter" }, scopes: ["ALL_SCOPES"] },
    { name: "Semantic/Sans", type: "STRING", collection: "Type", values: { M: { aliasOf: "Primitive/Inter" } }, scopes: ["ALL_SCOPES"] },
    { name: "Heading", type: "STRING", collection: "Type", values: { M: { aliasOf: "Semantic/Sans" } }, scopes: ["FONT_FAMILY"] }] });
  const ct = toTailwind(chain);
  check("[chain] the whole alias chain under a font family is kept — no var() dangles",
    ct.text.includes("--font-figma-heading: var(--figma-semantic-sans);") && ct.text.includes("--figma-semantic-sans: var(--figma-primitive-inter);") && ct.text.includes("--figma-primitive-inter: Inter;")
    && !ct.warnings.some((w) => /leaves out/.test(w)));
})();

// ---------- STRING tokens in theme.css — the scope decides a font family; other strings stay out ----------
(() => {
  const ds = tokens({
    collections: [{ name: "Type", modes: ["Mode 1"], default: "Mode 1", theming: false, key: "7777aaaa11112222333344445555666677778888" }],
    variables: [
      { name: "Heading", type: "STRING", collection: "Type", values: { "Mode 1": "Open Sans" }, scopes: ["FONT_FAMILY"], key: "s1" },
      { name: "Body", type: "STRING", collection: "Type", values: { "Mode 1": "Inter" }, scopes: ["FONT_FAMILY"], key: "s2" },
      { name: "Weight/Strong", type: "STRING", collection: "Type", values: { "Mode 1": "Semi Bold" }, scopes: ["ALL_SCOPES"], key: "s3" },
      { name: "Weight/Plain", type: "STRING", collection: "Type", values: { "Mode 1": "Regular" }, scopes: ["FONT_STYLE"], key: "s4" },
      { name: "Font Family/Mono", type: "STRING", collection: "Type", values: { "Mode 1": "Fira Code" }, scopes: ["ALL_SCOPES"], key: "s5" },
    ],
  });
  const tw = toTailwind(ds);
  check("a FONT_FAMILY-scoped STRING named 'Heading' (collection 'Type') is a font family: --font-figma-heading", /--font-figma-heading: /.test(tw.text));
  check("a font family with a space is a quoted font-family value; a one-word one is left bare",
    tw.text.includes('  --font-figma-heading: "Open Sans";') && tw.text.includes("  --font-figma-body: Inter;"));
  check("with ALL_SCOPES the name still decides (fallback): 'Font Family/Mono' is a font family", tw.text.includes('  --font-figma-font-family-mono: "Fira Code";'));
  check("'Semi Bold' (ALL_SCOPES) and 'Regular' (FONT_STYLE) are NOT written to theme.css", !/Semi Bold|Regular|weight/i.test(tw.text));
  check("ONE warning names the left-out strings and where they are kept",
    tw.warnings.filter((w) => /theme\.css leaves out 2 STRING token\(s\) that are not font families \('Weight\/Strong', 'Weight\/Plain'\)/.test(w) && /tokens\.dtcg\.json/.test(w) && /--also-generic/.test(w)).length === 1);
  check("tokens.css still carries them as plain custom properties (unchanged)", /--Weight-Strong: Semi Bold;/.test(toCSS(ds)));
  check("emitTokens passes theme.css's warnings through", emitTokens(ds, { tailwind: true }).warnings.some((w) => /theme\.css leaves out 2 STRING/.test(w)));
  const aliased = tokens({ collections: [{ name: "Type", modes: ["M"], default: "M" }], variables: [
    { name: "Primitive/Inter", type: "STRING", collection: "Type", values: { M: "Inter" }, scopes: ["ALL_SCOPES"] },
    { name: "Heading", type: "STRING", collection: "Type", values: { M: { aliasOf: "Primitive/Inter" } }, scopes: ["FONT_FAMILY"] }] });
  const at = toTailwind(aliased).text;
  check("a STRING a font family aliases is kept, so the var() resolves", /--font-figma-heading: var\(--figma-primitive-inter\);/.test(at) && /--figma-primitive-inter: Inter;/.test(at));
})();

// ---------- lint warnings name the CSS file(s) actually written; the @source not suggestion ----------
(() => {
  const TOK = path.join(import.meta.dirname, "..", "claude-plugin", "scripts", "tokens.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt24-lint-"));
  const input = path.join(dir, "variables.json");
  fs.writeFileSync(input, JSON.stringify({ collections: [{ name: "Spacing", modes: ["Mode 1"], default: "Mode 1", theming: false, key: "69f809ce00000000000000000000000000000000" }],
    variables: [{ name: "(Space 3)", type: "FLOAT", collection: "Spacing", tier: "primitive", values: { "Mode 1": 12 }, scopes: ["GAP"], key: "k1" }] }));
  const run = (out: string, extra: string[]) => spawnSync(process.execPath, [TOK, input, path.join(dir, out), ...extra], { encoding: "utf8" });
  const illegal = (stderr: string) => stderr.split("\n").find((l) => /illegal in a CSS custom property/.test(l)) ?? "";
  const tw = run("tw", ["--web", "tailwind"]), gen = run("gen", []), both = run("both", ["--web", "tailwind", "--also-generic"]);
  check("--web tailwind: the illegal-character warning names theme.css (what was written), not tokens.css",
    tw.status === 0 && / in theme\.css/.test(illegal(tw.stderr)) && !/tokens\.css/.test(illegal(tw.stderr)) && illegal(tw.stderr).includes("--spacing-figma-space-3") && !fs.existsSync(path.join(dir, "tw", "tokens.css")));
  check("default run: it names tokens.css", /emitted as ---Space-3- in tokens\.css$/.test(illegal(gen.stderr)) && !/theme\.css/.test(illegal(gen.stderr)));
  check("--also-generic: it names both", /in tokens\.css/.test(illegal(both.stderr)) && /in theme\.css/.test(illegal(both.stderr)));
  const note = (stderr: string) => stderr.split("\n").filter((l) => /^note {2}.*@source not "<path from that CSS file to design\/>";/.test(l) && /v4\.1\+/.test(l));
  check("--web tailwind prints ONE @source not suggestion (stderr, beside the other notes) and does not write it into theme.css",
    note(tw.stderr).length === 1 && !/@source/.test(fs.readFileSync(path.join(dir, "tw", "theme.css"), "utf8")));
  check("without --web tailwind there is no such note", note(gen.stderr).length === 0);
})();

// ---------- the design-system split: these CLIs must reject the slim manifest -----------------
// design/design-system.json no longer carries variables/components. Handing it to tokens.js or
// drift-lint.js would emit an empty token file / "0/0 mapped" — a silent wrong answer, not an error.
const manifest = { exportedAt: "2026-08-16T00:00:00.000Z", file: "Demo",
  files: { tokens: "design-system/tokens.json", componentsLocal: "design-system/components.local.json" },
  counts: { variables: 12, components: 3 } };
check("[manifest-guard] the slim manifest is detected when tokens.js wants `variables`", isManifest(manifest, "variables"));
check("[manifest-guard] and when drift-lint/map-bootstrap want `components`", isManifest(manifest, "components"));
check("[manifest-guard] a real split token file is NOT flagged", !isManifest({ exportedAt: "x", variables: [], collections: [] }, "variables"));
check("[manifest-guard] a real split component file is NOT flagged", !isManifest({ exportedAt: "x", components: [] }, "components"));
check("[manifest-guard] an EMPTY payload array still passes — zero variables is a legitimate export",
  !isManifest({ files: { tokens: "t" }, variables: [] }, "variables"));
check("[manifest-guard] junk/undefined input does not throw or false-positive",
  !isManifest(null, "variables") && !isManifest({ files: ["a"] }, "variables"));

// ---------- a missing input file is a SENTENCE, not an ENOENT stack trace --------------------
// a --node/single-screen pull never writes design/design-system/, so every
// one of these CLIs is routinely pointed at a file that legitimately does not exist. Dying with a
// raw stack whose top frame is a line number inside this repo reads like the tool broke. These run
// as real subprocesses because the behaviour under test IS the process exit + what lands on stderr.
(() => {
  const D2C = path.join(import.meta.dirname, "..", "design-to-code");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "d2c-enoent-"));
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [path.join(D2C, script), ...args], { encoding: "utf8", cwd });
  const GONE = "design/design-system/components.local.json";
  const cases: [string, string[], RegExp][] = [
    ["map-bootstrap.ts", [GONE, "--out", "codeconnect.local.json"], /component catalog/],
    ["drift-lint.ts", ["codeconnect.local.json", GONE], /component catalog/],
    ["tokens.ts", ["design/design-system/tokens.json", "out"], /token catalog/],
    ["map-validate.ts", ["codeconnect.local.json"], /component map/],
    ["audit.ts", ["design/Nope.json"], /screen export/],
    ["design-diff.ts", ["design/Nope.json"], /export/],
  ];
  for (const [script, args, what] of cases) {
    const r = run(script, args);
    const err = r.stderr || "";
    check(`[enoent-${script}] a missing input exits 2 with one 'does not exist' line, no stack`,
      r.status === 2 && /^error {2}/m.test(err) && what.test(err) && /does not exist/.test(err)
      && !/ENOENT/.test(err) && !/\n {4}at /.test(err));
  }
  // The hint is the actionable half: it must name the pull that WOULD create the missing file.
  const boot = run("map-bootstrap.ts", [GONE, "--out", "codeconnect.local.json"]).stderr;
  check("[enoent-hint] the catalog tools explain that a single-screen pull writes no design-system/",
    /--design-system/.test(boot) && /--node/.test(boot) && /every instance then counts as new/.test(boot));
  check("[enoent-hint] tokens.js points at the file a single-screen pull DOES write",
    /design\/export\/variables\.json/.test(run("tokens.ts", ["design/design-system/tokens.json", "out"]).stderr));
  // …and a file that exists but is not JSON is its own sentence, not a SyntaxError stack.
  fs.writeFileSync(path.join(cwd, "broken.json"), "{oops");
  const bad = run("map-validate.ts", ["broken.json"]);
  check("[enoent-badjson] unparseable JSON is reported as such, with the parser's reason",
    bad.status === 2 && /is not valid JSON/.test(bad.stderr) && !/\n {4}at /.test(bad.stderr));
  // Guard the opposite direction: a file that IS there must still be processed normally.
  fs.writeFileSync(path.join(cwd, "ok.json"), JSON.stringify({ version: 1, components: {} }));
  check("[enoent-negative] an existing, valid file is unaffected by the guard",
    run("map-validate.ts", ["ok.json"]).status === 0);
  // A UTF-8 BOM (invisible before the `{`) is real bytes JSON.parse chokes on — strip it before parsing.
  const bomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ version: 1, components: {} }), "utf8")]);
  fs.writeFileSync(path.join(cwd, "bom.json"), bomBuf);
  check("[bom-utf8] a UTF-8 BOM'd valid map parses and passes its guard",
    run("map-validate.ts", ["bom.json"]).status === 0);
  // A UTF-16 file (typically saved by a Windows editor) is not valid UTF-8 at all: report it as such,
  // one line, exit 2 — not a mangled JSON.parse SyntaxError.
  const u16Buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ version: 1, components: {} }), "utf16le")]);
  fs.writeFileSync(path.join(cwd, "utf16.json"), u16Buf);
  const u16 = run("map-validate.ts", ["utf16.json"]);
  check("[bom-utf16] a UTF-16 file is reported as such, one line, exit 2",
    u16.status === 2 && /is UTF-16, not UTF-8 — re-save it as UTF-8/.test(u16.stderr) && !/\n {4}at /.test(u16.stderr));
})();

// ---------- a file of the WRONG KIND is a sentence too (doc-guards.ts), not a TypeError or a quiet no-op ----------
// Each of these used to be read as `JSON.parse(…) as T`: a catalog whose `components` was a string made
// drift-lint lint nothing, a token file with a broken row died inside the emitter, a screen with no
// nodes produced an empty result that read like a clean run.
(() => {
  const D2C = path.join(import.meta.dirname, "..", "design-to-code");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "d2c-shape-"));
  const put = (name: string, doc: unknown): string => { fs.writeFileSync(path.join(cwd, name), JSON.stringify(doc)); return name; };
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [path.join(D2C, script), ...args], { encoding: "utf8", cwd });
  const oneLine = (r: { status: number | null; stderr: string }, re: RegExp): boolean => r.status === 2 && re.test(r.stderr) && !/\n {4}at /.test(r.stderr) && !/TypeError/.test(r.stderr);
  put("map.json", { version: 1, components: {} });
  const badCat = put("bad-catalog.json", { components: "Button" });
  const badTok = put("bad-tokens.json", { variables: [{ name: "a", type: "COLOR" }] });
  const badScreen = put("bad-screen.json", { screen: "S", nodes: [{ name: "no id or type" }] });
  const goodCat = put("catalog.json", { components: [{ name: "B", key: "K", type: "COMPONENT" }] });
  check("[shape-drift-catalog] drift-lint: a catalog whose components is not an array -> exit 2, one line",
    oneLine(run("drift-lint.ts", ["map.json", badCat]), /component catalog: 'bad-catalog\.json' is not a component catalog/));
  check("[shape-drift-screen] drift-lint --screen: a screen export with no real nodes -> exit 2, one line",
    oneLine(run("drift-lint.ts", ["map.json", goodCat, "--screen", badScreen]), /screen export: 'bad-screen\.json' is not a screen export/));
  check("[shape-tokens] tokens: a variable with no values -> exit 2 naming the token catalog shape",
    oneLine(run("tokens.ts", [badTok, "out"]), /token catalog: 'bad-tokens\.json' is not a token catalog/));
  check("[shape-bootstrap] map-bootstrap: a malformed catalog -> exit 2, nothing written",
    oneLine(run("map-bootstrap.ts", [badCat, "--out", "out-map.json"]), /is not a component catalog/) && !fs.existsSync(path.join(cwd, "out-map.json")));
  check("[shape-bootstrap-proposals] map-bootstrap --from-proposals: rows that are not proposals (no name) are not proposals",
    (() => { const r = run("map-bootstrap.ts", [goodCat, "--from-proposals", put("props.json", { componentProposals: [{ confirmed: true }] })]); return r.status === 1 && /has no componentProposals/.test(r.stderr); })());
  check("[shape-bootstrap-screen] map-bootstrap --screen: a malformed screen -> exit 2",
    oneLine(run("map-bootstrap.ts", [goodCat, "--screen", badScreen]), /is not a screen export/));
  check("[shape-get-component] getComponent: a malformed catalog throws ONE sentence (the MCP tool error), not a TypeError", (() => {
    try { getComponent(path.join(cwd, badCat), "K"); return false; } catch (e) { return e instanceof Error && /is not a component catalog/.test(e.message) && !(e instanceof TypeError); }
  })());
  check("[shape-get-component-cli] get-component CLI: the same, as `error  …` exit 2", (() => {
    const r = run("get-component.ts", [badCat, "K"]);
    return r.status === 2 && /^error {2}'bad-catalog\.json' is not a component catalog/m.test(r.stderr);
  })());
  // parseArgs (node:util): a value-taking flag never swallows the next flag as its value.
  check("[args] tokens: `--native --package x` is '--native needs a value', not a platform named '--package'", (() => {
    const r = run("tokens.ts", [goodCat, "out", "--native", "--package", "x"]);
    return r.status === 1 && /tokens: --native needs a value/.test(r.stderr);
  })());
  check("[args] drift-lint: every unknown flag is named (not only the first)", (() => {
    const r = run("drift-lint.ts", ["map.json", goodCat, "--scren", "x", "--max-agee", "1"]);
    return r.status === 2 && /unknown flag --scren, --max-agee/.test(r.stderr);
  })());
  check("[args] drift-lint: `--max-age -5` (space form) is refused as not positive, not as '--max-age needs a value'", (() => {
    const r = run("drift-lint.ts", ["map.json", goodCat, "--max-age", "-5"]);
    return r.status === 2 && /--max-age expects a positive number of hours/.test(r.stderr);
  })());
  // the usage line is text the model copies into Bash, where ${CLAUDE_PLUGIN_ROOT} is empty — so it
  // names the script by the real path it is running from (here, the source; installed, the bundle).
  check("[usage] the usage line names the script by its real path (node \"<its own folder>/<name>\"), not ${CLAUDE_PLUGIN_ROOT}",
    run("drift-lint.ts", []).stderr.includes(`usage: node "${path.join(D2C, "drift-lint.ts")}"`)
    && run("tokens.ts", ["--help"]).stdout.includes(`usage: node "${path.join(D2C, "tokens.ts")}"`));
})();

// ---------- tokens: the export's colour profile (the plugin writes Figma's DISPLAY_P3 lowercased: "display_p3") ----------
console.log("tokens — colour profile:");
check("[p3] a real export's `colorProfile: \"display_p3\"` stamp yields display-p3 DTCG colours", (() => {
  const d = toDTCG(tokens({ colorProfile: "display_p3", variables: [{ name: "brand", type: "COLOR", values: { v: "#2563eb" } }] }));
  return asColor(leafAt(d, "brand").$value).colorSpace === "display-p3";
})());
check("[p3] …through hexToColorValue too, and srgb stays srgb", hexToColorValue("#2563eb", "display_p3")?.colorSpace === "display-p3" && hexToColorValue("#2563eb", "srgb")?.colorSpace === "srgb");

// ---------- tokens: EASING / TIMING variables (motion OBJECTS, not scalars) are skipped cleanly ----------
console.log("tokens — non-scalar variable types:");
{
  // VariableType does not list EASING yet (bridge/src/doc-types.ts grows it with the producer), hence malformed().
  const motion = malformed<TokensDoc>({ collections: [{ name: "M", modes: ["v"], default: "v", theming: false }], variables: [
    { name: "ease/out", type: "EASING", collection: "M", tier: "primitive", values: { v: { type: "EASE_OUT", easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } } } },
    { name: "brand", type: "COLOR", collection: "M", tier: "primitive", values: { v: "#2563eb" } }] });
  const w: string[] = [];
  const d = toDTCG(motion, w);
  check("[easing] toDTCG skips an EASING variable with a warning naming it; the COLOR beside it is emitted", nodeAt(d, "ease") === undefined && w.some((m) => /ease\/out.*EASING/.test(m)) && leafAt(d, "brand").$type === "color");
  const css = toCSS(motion);
  check("[easing] toCSS writes no `[object Object]` and no --ease-out", !css.includes("[object Object]") && !css.includes("--ease-out") && css.includes("--brand: #2563eb;"));
  const n = toNative(motion, "swiftui");
  check("[easing] toNative skips it with a warning instead of emitting a broken literal", !n.text.includes("[object Object]") && !/easeOut/.test(n.text) && n.warnings.some((m) => /ease\/out.*EASING/.test(m)));
}

// ---------- tokens: Figma's 0–100 opacity scale (REST API variables types: "An opacity percentage from 0 to 100") ----------
console.log("tokens — opacity FLOATs are percentages:");
{
  const opDs = tokens({ variables: [
    { name: "op/a", type: "FLOAT", scopes: ["OPACITY"], values: { v: 40 } },
    { name: "op/hi", type: "FLOAT", scopes: ["COLOR_OPACITY"], values: { v: 120 } },
    { name: "op/lo", type: "FLOAT", scopes: ["OPACITY"], values: { v: -5 } },
    { name: "op/zero", type: "FLOAT", scopes: ["OPACITY"], values: { v: 0 } },
    { name: "weight", type: "FLOAT", scopes: ["FONT_WEIGHT"], values: { v: 700 } },
    { name: "gap", type: "FLOAT", scopes: ["GAP"], values: { v: 8 } }] });
  const css = toCSS(opDs);
  check("[pct] OPACITY-scoped 40 -> `40%` (a valid `opacity` and <alpha-value>)", css.includes("--op-a: 40%;"));
  check("[pct] COLOR_OPACITY-scoped 120 -> clamped `100%`; OPACITY -5 -> clamped `0%`", css.includes("--op-hi: 100%;") && css.includes("--op-lo: 0%;"));
  check("[pct] a 0 opacity keeps its `%` (`0%`, not the bare length-style 0)", css.includes("--op-zero: 0%;"));
  check("[pct] FONT_WEIGHT 700 stays a bare number; a GAP FLOAT stays px", css.includes("--weight: 700;") && css.includes("--gap: 8px;"));
  const lint = lintTokens(opDs);
  check("[pct] each clamp is a lint warning (120 and -5), an in-range value is not",
    lint.some((m) => /'op\/hi'.*120.*clamped to 100%/.test(m)) && lint.some((m) => /'op\/lo'.*-5.*clamped to 0%/.test(m)) && !lint.some((m) => /'op\/a'.*clamped/.test(m)));
  const d = toDTCG(opDs);
  check("[pct] DTCG keeps $type number + the VERBATIM number, and records unit: \"percent\"",
    leafAt(d, "op.a").$type === "number" && leafAt(d, "op.a").$value === 40 && figmaExt(leafAt(d, "op.a")).unit === "percent"
    && leafAt(d, "op.hi").$value === 120 && figmaExt(leafAt(d, "op.hi")).unit === "percent" && leafAt(d, "op.lo").$value === -5);
  check("[pct] DTCG: the opacity leaf is exactly what it was plus unit: \"percent\"",
    JSON.stringify(leafAt(d, "op.a")) === JSON.stringify({ $type: "number", $value: 40, $extensions: { "figma.com": { scopes: ["OPACITY"], unit: "percent" } } }));
  check("[pct] DTCG: FONT_WEIGHT and dimension tokens get no unit extension",
    figmaExt(leafAt(d, "weight")).unit === undefined && figmaExt(leafAt(d, "gap")).unit === undefined && leafAt(d, "weight").$value === 700);
  check("[pct] a FONT_WEIGHT+OPACITY mix and a name-only opacity stay bare numbers (no scale evidence)",
    toCSS(tokens({ variables: [{ name: "w/x", type: "FLOAT", scopes: ["FONT_WEIGHT", "OPACITY"], values: { v: 50 } }, { name: "Opacity/y", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 50 } }] }))
      .includes("--w-x: 50;\n  --Opacity-y: 50;"));
  check("[pct] opts.unitless overrides the scope (a bare number)", toCSS(opDs, { unitless: new Set(["op/a"]) }).includes("--op-a: 40;"));
  // The name heuristic (ALL_SCOPES + an "Opacity" segment) makes a token unitless but carries no scale
  // evidence: DTCG gives it NO unit, so tokens.css keeps it bare too — the two sides agree.
  const byName = tokens({ variables: [{ name: "Opacity/hover", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 50 } }] });
  check("[pct] a name-heuristic opacity: DTCG number 50 with no unit extension, CSS bare `50`",
    JSON.stringify(leafAt(toDTCG(byName), "Opacity.hover")) === JSON.stringify({ $type: "number", $value: 50, $extensions: { "figma.com": { scopes: ["ALL_SCOPES"] } } })
    && toCSS(byName).includes("--Opacity-hover: 50;"));
  // Resolver set files carry the same unit: "percent" tokens.dtcg.json carries (and only there).
  const opModes = tokens({ collections: [{ name: "Fx", modes: ["Calm", "Loud"], default: "Calm" }], variables: [
    { name: "fx/fade", type: "FLOAT", collection: "Fx", scopes: ["OPACITY"], values: { Calm: 40, Loud: 80 } },
    { name: "fx/gap", type: "FLOAT", collection: "Fx", scopes: ["GAP"], values: { Calm: 4, Loud: 8 } }] });
  const { resolver: or, files: of } = toResolver(opModes);
  const fxSet = must(or.sets.Fx, "resolver set 'Fx'");
  const fxLoudCtx = must(modifierOf(or, "Fx").contexts.Loud, "Fx modifier Loud context");
  const oBase = fileAt(of, must(fxSet.sources[0], "Fx set sources[0]").$ref), oLoud = fileAt(of, must(fxLoudCtx[0], "Fx Loud context[0]").$ref);
  check("[pct] resolver base set: the opacity leaf is {$type number, $value 40, $extensions figma.com unit percent}",
    JSON.stringify(leafAt(oBase, "fx.fade")) === JSON.stringify({ $type: "number", $value: 40, $extensions: { "figma.com": { unit: "percent" } } }));
  check("[pct] resolver mode context (Loud): 80 with the same unit; the GAP dimension gets no $extensions",
    JSON.stringify(leafAt(oLoud, "fx.fade")) === JSON.stringify({ $type: "number", $value: 80, $extensions: { "figma.com": { unit: "percent" } } })
    && JSON.stringify(leafAt(oBase, "fx.gap")) === JSON.stringify({ $type: "dimension", $value: { value: 4, unit: "px" } }));
  check("[pct] tokens.dtcg.json and the resolver set agree on the unit", figmaExt(leafAt(toDTCG(opModes), "fx.fade")).unit === figmaExt(leafAt(oBase, "fx.fade")).unit);
  // Native: an out-of-range opacity is clamped as Figma clamps it (Help Center 14506821864087) and reported.
  const opNative = tokens({ collections: [{ name: "Fx", modes: ["M"], default: "M" }], variables: [
    { name: "fx/over", type: "FLOAT", collection: "Fx", scopes: ["COLOR_OPACITY"], values: { M: 120 } },
    { name: "fx/under", type: "FLOAT", collection: "Fx", scopes: ["OPACITY"], values: { M: -5 } },
    { name: "fx/half", type: "FLOAT", collection: "Fx", scopes: ["OPACITY"], values: { M: 12.5 } },
    { name: "Opacity/named", type: "FLOAT", collection: "Fx", scopes: ["ALL_SCOPES"], values: { M: 50 } }] });
  const opKt = toNative(opNative, "compose");
  check("[pct] native: 120 -> 1f, -5 -> 0f, 12.5 -> 0.125f; a name-heuristic opacity stays verbatim (50f), like its CSS",
    opKt.text.includes("    val fxOver: Float = 1f // fx/over\n") && opKt.text.includes("    val fxUnder: Float = 0f // fx/under\n")
    && opKt.text.includes("    val fxHalf: Float = 0.125f // fx/half\n") && opKt.text.includes("    val opacityNamed: Float = 50f // Opacity/named\n"));
  check("[pct] native: each clamp is a warning, an in-range value is not",
    opKt.warnings.includes("fx/over (mode M): opacity 120 is outside Figma's 0–100 range; clamped to 100 (as Figma does) and written as 1")
    && opKt.warnings.includes("fx/under (mode M): opacity -5 is outside Figma's 0–100 range; clamped to 0 (as Figma does) and written as 0")
    && !opKt.warnings.some((m) => /fx\/half/.test(m)));
  // The Compose "active mode" hint names the first mode whose NAME differs from the default's (picking by id
  // would emit `Light2` here instead of `Dark`). doc-guards.ts accepts repeated mode
  // names, so a collection like ["Light", "Light", "Dark"] is a reachable input.
  const dupModes = tokens({ collections: [{ name: "Theme", modes: ["Light", "Light", "Dark"], default: "Light" }], variables: [
    { name: "fx/gap", type: "FLOAT", collection: "Theme", scopes: ["GAP"], values: { Light: 4, Dark: 8 } }] });
  const dupKt = toNative(dupModes, "compose").text;
  check("[modes] Compose hint: with repeated mode names the active mode is still the first DIFFERENTLY named one (Dark, not the second Light)",
    dupKt.includes("CompositionLocalProvider(LocalThemeTokens provides ThemeTokensDark) { … }"));
  const sameModes = tokens({ collections: [{ name: "Theme", modes: ["Light", "Light"], default: "Light" }], variables: [
    { name: "fx/gap", type: "FLOAT", collection: "Theme", scopes: ["GAP"], values: { Light: 4 } }] });
  const sameKt = toNative(sameModes, "compose").text;
  check("[modes] Compose hint: every mode named like the default (formerly a TypeError) falls back to the second mode by id",
    sameKt.includes("CompositionLocalProvider(LocalThemeTokens provides ThemeTokensLight2) { … }"));
}

// ---------- tokens: COMPOSED colour variables (Figma Update 139: colour + separate opacity, one or both aliases) ----------
console.log("tokens — composed colours:");
{
  const composed = tokens({ colorProfile: "srgb",
    collections: [{ name: "Prim", modes: ["Value"], default: "Value" }, { name: "Theme", modes: ["Light", "Dark"], default: "Light", theming: true }],
    variables: [
      { name: "ink", type: "COLOR", collection: "Prim", values: { Value: "#111111" } },
      { name: "opacity/60", type: "FLOAT", collection: "Prim", scopes: ["COLOR_OPACITY"], values: { Value: 60 } },
      // form 1: raw colour + opacity alias
      { name: "overlay/scrim", type: "COLOR", collection: "Theme", values: {
        Light: { composed: { color: "#000000", opacity: { aliasOf: "opacity/60" } } },
        Dark: { composed: { color: "#ffffff", opacity: { aliasOf: "opacity/60" } } } } },
      // form 2: colour alias + raw opacity (Light) / + opacity alias (Dark)
      { name: "text/muted", type: "COLOR", collection: "Theme", values: {
        Light: { composed: { color: { aliasOf: "ink" }, opacity: 50 } },
        Dark: { composed: { color: { aliasOf: "ink" }, opacity: { aliasOf: "opacity/60" } } } } }] });
  const w: string[] = [];
  const d = toDTCG(composed, w);
  const muted = leafAt(d, "text.muted"), scrim = leafAt(d, "overlay.scrim");
  check("[composed] colour alias + number opacity: a colour token whose $value is the reference, opacity under $extensions",
    muted.$type === "color" && muted.$value === "{ink}" && figmaExt(muted).opacity === 50);
  check("[composed] per mode: the colour half in .modes, the opacity half (number or reference) in .modeOpacity",
    modesOf(muted).Dark === "{ink}" && JSON.stringify(figmaExt(muted).modeOpacity) === JSON.stringify({ Light: 50, Dark: "{opacity.60}" }));
  check("[composed] raw colour + opacity alias: a structured DTCG colour $value + the opacity reference",
    scrim.$type === "color" && asColor(scrim.$value).hex === "#000000" && asColor(scrim.$value).alpha === undefined && figmaExt(scrim).opacity === "{opacity.60}"
    && asColor(modesOf(scrim).Dark).hex === "#ffffff");
  check("[composed] neither token is skipped as non-scalar", !w.some((m) => /overlay\/scrim|text\/muted/.test(m)));
  check("[composed] a COLOR_OPACITY-scoped FLOAT stays a unitless number", leafAt(d, "opacity.60").$type === "number" && leafAt(d, "opacity.60").$value === 60);
  const { resolver: cr, files: cf } = toResolver(composed);
  const themeSet = must(cr.sets.Theme, "resolver set 'Theme'");
  const themeDarkCtx = must(modifierOf(cr, "Theme").contexts.Dark, "Theme modifier Dark context");
  const base = fileAt(cf, must(themeSet.sources[0], "Theme set sources[0]").$ref), dark = fileAt(cf, must(themeDarkCtx[0], "Theme Dark context[0]").$ref);
  check("[composed] resolver set files carry the opacity with the value they pick (default mode and Dark context)",
    leafAt(base, "text.muted").$value === "{ink}" && figmaExt(leafAt(base, "text.muted")).opacity === 50
    && leafAt(dark, "text.muted").$value === "{ink}" && figmaExt(leafAt(dark, "text.muted")).opacity === "{opacity.60}");
  const css = toCSS(composed);
  const darkBlock = (css.match(/\[data-theme="Dark"\] \{([\s\S]*?)\}/) || ["", ""])[1] ?? "";
  // color-mix(in srgb, <colour> <N%>, transparent): MDN color-mix, "adding transparency".
  check("[composed] tokens.css: colour alias + number opacity -> color-mix(in srgb, var(--ink) 50%, transparent)",
    !css.includes("[object Object]") && css.includes("--text-muted: color-mix(in srgb, var(--ink) 50%, transparent);"));
  check("[composed] tokens.css: hex + opacity alias -> color-mix(in srgb, #000000 var(--opacity-60), transparent)",
    css.includes("--overlay-scrim: color-mix(in srgb, #000000 var(--opacity-60), transparent);")
    && darkBlock.includes("--overlay-scrim: color-mix(in srgb, #ffffff var(--opacity-60), transparent);"));
  check("[composed] tokens.css: colour alias + opacity alias -> color-mix(in srgb, var(--ink) var(--opacity-60), transparent), and the opacity var is a percentage",
    darkBlock.includes("--text-muted: color-mix(in srgb, var(--ink) var(--opacity-60), transparent);") && css.includes("--opacity-60: 60%;"));
  const twc = toTailwind(composed).text;
  check("[composed] theme.css: the same forms against the Tailwind names",
    twc.includes("--color-figma-text-muted: color-mix(in srgb, var(--color-figma-ink) 50%, transparent);")
    && twc.includes("--color-figma-overlay-scrim: color-mix(in srgb, #000000 var(--figma-opacity-60), transparent);")
    && twc.includes("--figma-opacity-60: 60%;"));
  const lint = lintTokens(composed);
  check("[composed] lint no longer says the CSS dropped the opacity (it carries it), and calls no nested alias dangling",
    !lint.some((m) => /composed colour/.test(m)) && !lint.some((m) => /undefined token/.test(m)));
  // An opacity alias whose target's CSS is NOT a percentage (an unscoped FLOAT -> `40px`) would make
  // color-mix() invalid, so that value alone falls back to the colour half — and says so.
  const pxOp = tokens({ variables: [
    { name: "ink", type: "COLOR", values: { v: "#111111" } },
    { name: "fade", type: "FLOAT", values: { v: 40 } },
    { name: "a", type: "COLOR", values: { v: { composed: { color: { aliasOf: "ink" }, opacity: { aliasOf: "fade" } } } } }] });
  check("[composed] opacity alias to a non-percentage FLOAT: tokens.css keeps the colour half only, lint says so",
    toCSS(pxOp).includes("--a: var(--ink);") && lintTokens(pxOp).some((m) => /'a'.*composed colour.*'fade'.*colour only/.test(m)));
  const hot = tokens({ variables: [
    { name: "ink", type: "COLOR", values: { v: "#111111" } },
    { name: "a", type: "COLOR", values: { v: { composed: { color: { aliasOf: "ink" }, opacity: 150 } } } }] });
  check("[composed] a number opacity above 100 is clamped to 100% in CSS (as Figma does), with a lint warning; DTCG keeps 150",
    toCSS(hot).includes("--a: color-mix(in srgb, var(--ink) 100%, transparent);") && lintTokens(hot).some((m) => /'a'.*150.*clamped to 100%/.test(m))
    && figmaExt(leafAt(toDTCG(hot), "a")).opacity === 150);
  check("[composed] a DANGLING nested alias is reported like a top-level one", lintTokens(tokens({ variables: [
    { name: "a", type: "COLOR", values: { v: { composed: { color: "#000000", opacity: { aliasOf: "gone/op" } } } } }] })).some((m) => /'a'.*undefined token 'gone\/op'/.test(m)));
  // Native: folded into ONE colour, alpha × opacity/100 (color.ts composeAlpha), each half resolved like
  // a plain colour. text/muted Light = ink #111111 at 50 -> alpha 0.5 -> round(127.5) = 128 = 0x80;
  // Dark = ink at opacity/60 (alias -> 60) -> 0.6 × 255 = 153 = 0x99. overlay/scrim Light = #000000 at
  // 60 -> 0x99, Dark = #ffffff at 60 -> 0x99.
  const n = toNative(composed, "swiftui"), nk = toNative(composed, "compose"), nd = toNative(composed, "flutter"), nr = toNative(composed, "react-native");
  check("[composed] toNative folds it into one colour: Compose ARGB 0x80111111 (Light) / 0x99111111 (Dark), scrim 0x99000000 / 0x99FFFFFF",
    /ThemeTokensLight = ThemeTokens\(\n {4}overlayScrim = Color\(0x99000000\),\n {4}textMuted = Color\(0x80111111\),/.test(nk.text)
    && /ThemeTokensDark = ThemeTokens\(\n {4}overlayScrim = Color\(0x99FFFFFF\),\n {4}textMuted = Color\(0x99111111\),/.test(nk.text));
  check("[composed] SwiftUI: the composed alpha is the Color opacity (128/255 = 0.502, 153/255 = 0.6)",
    n.text.includes("textMuted: Color(.sRGB, red: 0.0667, green: 0.0667, blue: 0.0667, opacity: 0.502)")
    && n.text.includes("textMuted: Color(.sRGB, red: 0.0667, green: 0.0667, blue: 0.0667, opacity: 0.6)"));
  check("[composed] Flutter Color(0x80111111) and React Native \"#11111180\" (Light text/muted)",
    nd.text.includes("    textMuted: Color(0x80111111),\n") && nr.text.includes("    textMuted: \"#11111180\",\n"));
  check("[composed] no composed-colour skip warning when both halves resolve, and no broken literal",
    !n.text.includes("[object Object]") && !n.warnings.some((m) => /composed colour/.test(m)));
  // A half that does not resolve inside the file (the opacity alias names a variable that was not
  // exported) is still skipped, with the composed-colour warning.
  const lost = toNative(tokens({ collections: [{ name: "C", modes: ["M"], default: "M" }], variables: [
    { name: "ink", type: "COLOR", collection: "C", values: { M: "#111111" } },
    { name: "fg/faint", type: "COLOR", collection: "C", values: { M: { composed: { color: { aliasOf: "ink" }, opacity: { aliasOf: "lib/op" } } } } }] }), "swiftui");
  check("[composed] an unresolvable half: skipped with the composed-colour warning, no field emitted",
    !lost.text.includes("fgFaint") && lost.warnings.some((m) => m.startsWith("fg/faint: skipped — a composed colour (colour + separate opacity) whose colour or opacity could not be resolved inside this file")));
}

// ---------- kinds.ts: a SLOT component property maps to an instance slot (the plugin emits SLOT) ----------
console.log("map — SLOT props:");
{
  // ComponentPropType does not list SLOT yet (doc-types grows it); TYPE_TO_KIND already does.
  const slotCat = malformed<ComponentsCatalog>({ components: [{ key: "K", name: "Card", type: "COMPONENT", props: { Content: { key: "Content#1:2", type: "SLOT" } } }] });
  const m = bootstrap(slotCat);
  check("[slot] bootstrap stubs a SLOT prop as {kind:\"instance\", slot}", instanceProp(m, "K", "Content").slot === "content" && validateMap(m).ok);
  check("[slot] drift-lint: a SLOT prop mapped as an instance is not a kind-mismatch", driftLint(codeMap({ K: { figma: { key: "K", name: "Card" }, props: { Content: { kind: "instance", slot: "content" } } } }), slotCat).errors.every((e) => e.code !== "kind-mismatch"));
}

// ---------- an INVALID map is a validation message, not a TypeError, and is never rewritten ----------
// drift-lint's only map check was "is it an object", so {"components":{"X":null}} reached driftLint and
// died with a TypeError stack. map-bootstrap merged whatever it read and rewrote it: an array
// `components` came back as {"0": …}. Both now run map-validate's validator first.
(() => {
  const D2C = path.join(import.meta.dirname, "..", "design-to-code");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "d2c-badmap-"));
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [path.join(D2C, script), ...args], { encoding: "utf8", cwd });
  fs.writeFileSync(path.join(cwd, "catalog.json"), JSON.stringify({ exportedAt: new Date().toISOString(), components: [] }));
  fs.writeFileSync(path.join(cwd, "null-entry.json"), JSON.stringify({ version: 1, components: { X: null } }));
  const dl = run("drift-lint.ts", ["null-entry.json", "catalog.json"]);
  check("[map-invalid] drift-lint on {components:{X:null}} exits non-zero with the validator's message",
    dl.status !== 0 && /ERROR\s+\[map-invalid\] null-entry\.json: components\.X: entry must be an object/.test(dl.stderr));
  check("[map-invalid] …and no TypeError / stack trace", !/TypeError/.test(dl.stderr) && !/\n {4}at /.test(dl.stderr));
  const arrayMap = JSON.stringify({ version: 1, components: [] });
  fs.writeFileSync(path.join(cwd, "array-map.json"), arrayMap);
  const mb = run("map-bootstrap.ts", ["catalog.json", "--out", "array-map.json"]);
  check("[map-invalid] map-bootstrap refuses an existing map whose components is an array (exit 1, names the problem)",
    mb.status === 1 && /components: must be an object/.test(mb.stderr) && /refusing to rewrite/.test(mb.stderr));
  check("[map-invalid] …and leaves the file byte-for-byte untouched", fs.readFileSync(path.join(cwd, "array-map.json"), "utf8") === arrayMap);
  // A valid hand-edited map is merged into atomically and in its own format (not rewritten as LF, 2 spaces)
  fs.writeFileSync(path.join(cwd, "hand-map.json"), JSON.stringify({ version: 1, components: {} }, null, 4).split("\n").join("\r\n") + "\r\n");
  const hm = run("map-bootstrap.ts", ["catalog.json", "--out", "hand-map.json"]);
  const hmText = fs.readFileSync(path.join(cwd, "hand-map.json"), "utf8");
  check("map-bootstrap keeps a hand-edited map's own format (CRLF, 4-space indent) and leaves no temp file beside it",
    hm.status === 0 && hmText.includes("\r\n    \"") && !/[^\r]\n/.test(hmText) && !fs.readdirSync(cwd).some((f) => f.includes(".tmp-")));
})();

// ---------- get-component.js: resolve a catalog entry -> its variantsFile detail -----------------
(() => {
  const gcDs: DesignSystemDoc = {
    exportedAt: "2026-08-18T00:00:00.000Z", file: "Demo", colorProfile: "srgb",
    collections: [], variables: [], styles: { paint: [], text: [], effect: [], grid: [] }, hygiene: [],
    components: [
      { key: "kset", name: "Badge", type: "COMPONENT_SET", id: "9:1", page: "P", pageId: "1:0",
        variants: [{ id: "9:2", name: "Size=Sm", key: "vk", values: { Size: "Sm" }, node: node({ type: "COMPONENT", id: "9:2", name: "Size=Sm" }) }] },
      { key: "kflat", name: "Icon", type: "COMPONENT_SET", id: "9:3", page: "P", pageId: "1:0",
        variants: [{ id: "9:4", name: "State=Default", key: "vk2", values: { State: "Default" } }] }, // no node -> no variantsFile
      { key: "kdup", name: "Same", id: "9:5", type: "COMPONENT" },
      { key: "kdup2", name: "Same", id: "9:6", type: "COMPONENT" },
      { key: "ksolo", name: "IconButton", id: "9:7", type: "COMPONENT", page: "P", pageId: "1:0",
        node: node({ type: "COMPONENT", id: "9:7", name: "IconButton", fills: [] }) }, // standalone COMPONENT, not a variant in a set
    ],
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "get-component-"));
  const built = buildDesignSystemLayout(gcDs, "/");
  fs.mkdirSync(path.join(tmp, built.dir, "components"), { recursive: true });
  for (const f of built.files) {
    fs.mkdirSync(path.dirname(path.join(tmp, f.path)), { recursive: true });
    fs.writeFileSync(path.join(tmp, f.path), JSON.stringify(f.data));
  }
  const catalogFile = path.join(tmp, "design-system", "components.local.json");
  const catalog = must(readJsonOrNull(catalogFile, isComponentsCatalog), "the written components.local.json");

  check("[get-component] resolves by key", findComponent(catalog, "kset")?.id === "9:1");
  check("[get-component] resolves by id", findComponent(catalog, "9:1")?.key === "kset");
  check("[get-component] resolves by name when unique", findComponent(catalog, "Icon")?.key === "kflat");
  check("[get-component] unresolved handle returns null", findComponent(catalog, "nope") === null);
  check("[get-component] ambiguous name throws rather than guessing", (() => {
    try { findComponent(catalog, "Same"); return false; } catch (e) { return e instanceof Error && "code" in e && e.code === "ambiguous-name"; }
  })());

  const res = foundOf(getComponent(catalogFile, "kset"));
  check("[get-component] found + variantsFile followed to the real node tree", res.detail?.variants?.[0]?.node?.type === "COMPONENT");
  check("[get-component] detail carries setId/setKey/name + the stamp", res.detail?.setId === "9:1" && res.detail.setKey === "kset" && res.detail.name === "Badge" && res.detail.exportedAt === "2026-08-18T00:00:00.000Z");

  const noNode = getComponent(catalogFile, "kflat");
  check("[get-component] a set with no exported node trees has no variantsFile and no detail", noNode.found && !("variantsFile" in noNode.component) && noNode.detail === null);

  check("[get-component] not-found handle reports found:false", getComponent(catalogFile, "nope").found === false);

  const solo = foundOf(getComponent(catalogFile, "ksolo"));
  check("[get-component] a standalone COMPONENT's slim entry carries nodeFile, not .node", !("node" in solo.component) && typeof solo.component.nodeFile === "string");
  check("[get-component] and nodeFile resolves to the real node tree", solo.detail?.node?.name === "IconButton");
  check("[get-component] standalone-COMPONENT detail carries id/key/name + the stamp", solo.detail?.id === "9:7" && solo.detail.key === "ksolo" && solo.detail.name === "IconButton" && solo.detail.exportedAt === "2026-08-18T00:00:00.000Z");

  fs.rmSync(tmp, { recursive: true, force: true });
})();

// ---------- native token files (tokens-native.ts) ----------
(() => {
  // until step 3: tokens.js adds these via Object.assign, not visible as named CJS exports
  const nds = tokens({
    collections: [{ name: "Theme", modes: ["Light", "Dark"], default: "Light" }, { name: "Primitive", modes: ["Mode 1"], default: "Mode 1" }, { name: "Font Sizes", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [
      { name: "Blue/500", type: "COLOR", collection: "Primitive", values: { "Mode 1": "#1A2B3C" }, scopes: ["ALL_SCOPES"] },
      { name: "Blue/200", type: "COLOR", collection: "Primitive", values: { "Mode 1": "#AABBCC80" }, scopes: ["ALL_SCOPES"] },
      { name: "Space/MD", type: "FLOAT", collection: "Primitive", values: { "Mode 1": 16 }, scopes: ["GAP"] },
      // Figma opacities are 0–100 percentages (REST API variables types): 40 is 40%.
      { name: "opacity/disabled", type: "FLOAT", collection: "Primitive", values: { "Mode 1": 40 }, scopes: ["OPACITY"] },
      { name: "Body", type: "FLOAT", collection: "Font Sizes", values: { "Mode 1": 14 }, scopes: ["ALL_SCOPES"] },
      { name: "Primary/Primary", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "Blue/500" }, Dark: { aliasOf: "Blue/200" } }, scopes: ["ALL_SCOPES"] },
      { name: "class", type: "COLOR", collection: "Theme", values: { Light: "#ffffff", Dark: "#000000" }, scopes: ["ALL_SCOPES"] },
      { name: "light", type: "COLOR", collection: "Theme", values: { Light: "#ffffff", Dark: "#000000" }, scopes: ["ALL_SCOPES"] },
      { name: "Primary primary", type: "COLOR", collection: "Theme", values: { Light: "#111111", Dark: "#222222" }, scopes: ["ALL_SCOPES"] },
      { name: "From/Library", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "Not/Exported" }, Dark: "#000000" }, scopes: ["ALL_SCOPES"] },
      { name: "Loop/A", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "Loop/A" }, Dark: { aliasOf: "Loop/A" } }, scopes: ["ALL_SCOPES"] },
    ],
  });
  const kt = toNative(nds, "android-compose", { package: "com.acme.ui" }), sw = toNative(nds, "swiftui"), da = toNative(nds, "flutter"), ts = toNative(nds, "react-native");
  check("[native] profile names resolve; an unknown platform throws", platformOf("android-compose") === "compose" && platformOf("nope") === null && (() => { try { toNative(nds, "nope"); return false; } catch { return true; } })());
  check("[native] file names per platform", kt.file === "DesignTokens.kt" && sw.file === "DesignTokens.swift" && da.file === "design_tokens.dart" && ts.file === "designTokens.ts");
  check("[native] aliases resolve PER MODE into concrete values (Light→Blue/500, Dark→Blue/200 with alpha as AARRGGBB)",
    /ThemeTokensLightMode = ThemeTokens\([\s\S]*?primaryPrimary = Color\(0xFF1A2B3C\)/.test(kt.text) && /ThemeTokensDark = ThemeTokens\([\s\S]*?primaryPrimary = Color\(0x80AABBCC\)/.test(kt.text)
    && !/ThemeTokensDark = ThemeTokens\([\s\S]*?primaryPrimary = Color\(0xFF1A2B3C\)/.test(kt.text));
  check("[native] compose: data class + CompositionLocal defaulting to the collection's default mode, package honoured",
    /^package com\.acme\.ui$/m.test(kt.text) && /@Immutable\ndata class ThemeTokens\(/.test(kt.text) && /val LocalThemeTokens = staticCompositionLocalOf \{ ThemeTokensLightMode \}/.test(kt.text));
  check("[native] compose units: spacing → dp, font size → sp (by name under ALL_SCOPES), OPACITY 40 → Float 0.4f (Modifier.alpha's 0–1)",
    /val spaceMD: Dp = 16\.dp/.test(kt.text) && /val body: TextUnit = 14\.sp/.test(kt.text) && kt.text.includes("    val opacityDisabled: Float = 0.4f // opacity/disabled\n"));
  check("[native] OPACITY 40 is the 0–1 fraction on every platform: SwiftUI Double 0.4, Flutter double 0.4, React Native 0.4",
    sw.text.includes("    public static let opacityDisabled: Double = 0.4 // opacity/disabled\n")
    && da.text.includes("  static const double opacityDisabled = 0.4; // opacity/disabled\n")
    && ts.text.includes("  opacityDisabled: 0.4, // opacity/disabled\n"));
  check("[native] a single-mode collection is plain constants, not a themed type", /^object PrimitiveTokens \{/m.test(kt.text) && /^public enum PrimitiveTokens \{/m.test(sw.text) && /^abstract final class PrimitiveTokens \{/m.test(da.text) && /^export const primitiveTokens = \{/m.test(ts.text));
  check("[native] reserved words and duplicate identifiers are renamed, with a warning for the duplicate",
    /val classToken: Color/.test(kt.text) && /val primaryPrimary2: Color/.test(kt.text) && kt.warnings.some((w) => /Primary primary.*primaryPrimary2/.test(w)));
  check("[native] a token named like a mode does not collide with the mode instance", /public static let lightMode = ThemeTokens\(/.test(sw.text) && /public let light: Color/.test(sw.text));
  check("[native] an alias that leaves the file, or loops, is skipped with a warning — never guessed",
    !/fromLibrary|loopA/.test(kt.text) && kt.warnings.filter((w) => /From\/Library|Loop\/A/.test(w)).length === 2);
  check("[native] swiftui: struct + static modes + EnvironmentValues entry", /public struct ThemeTokens: Sendable, Equatable \{/.test(sw.text) && /public init\(/.test(sw.text) && /static let defaultValue = ThemeTokens\.lightMode/.test(sw.text) && /var themeTokens: ThemeTokens \{/.test(sw.text)
    && /Color\(\.sRGB, red: 0\.102, green: 0\.1686, blue: 0\.2353, opacity: 1\)/.test(sw.text));
  check("[native] flutter: ThemeExtension with copyWith + lerp", /class ThemeTokens extends ThemeExtension<ThemeTokens> \{/.test(da.text) && /ThemeTokens copyWith\(\{/.test(da.text) && /primaryPrimary: Color\.lerp\(primaryPrimary, other\.primaryPrimary, t\)!/.test(da.text));
  check("[native] react-native: typed per-mode record, colors as hex strings, numbers unitless", /export const themeTokens: Record<ThemeTokensMode, ThemeTokens> = \{/.test(ts.text) && /primaryPrimary: "#1a2b3c"/.test(ts.text) && /spaceMD: 16,/.test(ts.text));
  check("[native] swiftui: the usage hint only offers colorScheme for a light/dark pair — any other axis names a real member", (() => {
    const t = toNative(tokens({ collections: [{ name: "Sizes", modes: ["Desktop", "Mobile"], default: "Desktop" }, { name: "Theme", modes: ["Light", "Dark"], default: "Light" }], variables: [{ name: "gap", type: "FLOAT", collection: "Sizes", values: { Desktop: 24, Mobile: 16 } }, { name: "bg", type: "COLOR", collection: "Theme", values: { Light: "#fff", Dark: "#000" } }] }), "swiftui").text;
    return /\\\.sizesTokens, \.mobile \/\* one of: \.desktop, \.mobile/.test(t) && /\\\.themeTokens, colorScheme == \.dark \? \.dark : \.light\)/.test(t) && !/sizesTokens, colorScheme/.test(t);
  })());
  check("[native] swiftui: a control character is escaped the Swift way (\\u{1}), not the JSON way", /"a\\u\{0001\}b"/.test(toNative(tokens({ collections: [{ name: "S", modes: ["M"], default: "M" }], variables: [{ name: "s", type: "STRING", collection: "S", values: { M: "a\u0001b" } }] }), "swiftui").text));
  check("[native] compose: the JVM limit is counted in parameter UNITS (Color = 2) — 130 colors in a themed collection warns, 100 does not", (() => {
    const ds = (n: number) => tokens({ collections: [{ name: "Big", modes: ["Light", "Dark"], default: "Light" }], variables: Array.from({ length: n }, (_, i) => ({ name: "c/" + i, type: "COLOR", collection: "Big", values: { Light: "#fff", Dark: "#000" } })) });
    return toNative(ds(130), "android-compose").warnings.some((w) => /JVM parameter units/.test(w)) && !toNative(ds(100), "android-compose").warnings.some((w) => /JVM/.test(w));
  })());
  check("[native] prototype-named modes/tokens cannot break the emitter", (() => { try { toNative(tokens({ collections: [{ name: "__proto__", modes: ["__proto__", "constructor"], default: "__proto__" }], variables: [{ name: "__proto__", type: "COLOR", collection: "__proto__", values: { __proto__: "#fff", constructor: "#000" } }] }), "flutter"); return true; } catch { return false; } })());
})();

// ---------- 0% screen coverage is a WARNING to confirm, exit 0 ----------
// 0% `screen-coverage` and `catalog-rekeyed` are warnings ending in a question to confirm (as cross-check's
// are) — "this catalog is not the library the screen uses" has a default (build every instance as new) and is the user's call.
// Still checked against the real map/catalog/screens in test/fixtures/livetest3/ (0% by map in both).
{
  const FXL = path.join(import.meta.dirname, "fixtures", "livetest3");
  const emptyMapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p6-123-")), "map.json");
  // version:1 — drift-lint validates the map now, and a map without it is not a valid map.
  fs.writeFileSync(emptyMapFile, JSON.stringify({ version: 1, components: {} }));
  const catalogFile = path.join(FXL, "design-system", "components.local.json");
  const screens = [
    path.join(FXL, "verify", "positions___7314_87192.json"),
    path.join(FXL, "verify", "Studio_Configurations__1359_21337.json"),
  ];
  for (const screen of screens) {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", "drift-lint.ts"), emptyMapFile, catalogFile, "--screen", screen], { encoding: "utf8" });
    check(`drift-lint --screen at 0% coverage: exit 0, a warn line with a Confirm question, no ERROR (${path.basename(screen)})`,
      r.status === 0 && /^warn\s+\[(screen-coverage|catalog-rekeyed)\] NONE/m.test(r.stderr) && /Confirm: .*\?/.test(r.stderr) && !/^ERROR/m.test(r.stderr));
  }
}

// ---------- 0% coverage and multi-catalog handling on the SHIPPED scripts: exit codes, and the catalogs beside the named one ----------
// drift-lint read ONE catalog, so an entry keyed to a component of a pulled library (libraries/<dir>/
// components.json) or of the sampled components.library.json was `orphaned-entry`, and map-bootstrap
// --screen never stubbed a library component. Real layout: design/export/{design-system,libraries}/.
(() => {
  const SCRIPTS = path.join(import.meta.dirname, "..", "claude-plugin", "scripts");
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: "utf8" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt26-"));
  const exp = path.join(root, "design", "export"), dsDir = path.join(exp, "design-system"), libDir = path.join(exp, "libraries", "acme-ui");
  fs.mkdirSync(dsDir, { recursive: true }); fs.mkdirSync(libDir, { recursive: true }); fs.mkdirSync(path.join(root, "other"));
  const stamp = { exportedAt: new Date().toISOString(), file: "Acme App", colorProfile: "srgb" };
  const put = (f: string, doc: unknown): string => { fs.writeFileSync(f, JSON.stringify(doc)); return f; };
  const label = { "Label#1:0": { key: "Label#1:0", type: "TEXT", default: "Label" } };
  const named = put(path.join(dsDir, "components.local.json"), { ...stamp, components: [{ name: "Brand Button", id: "1:1", type: "COMPONENT", key: "k-local", page: "Components", pageId: "0:1" }] });
  put(path.join(dsDir, "components.library.json"), { ...stamp, components: [{ name: "Surface Chip", key: "k-sample", type: "COMPONENT", remote: true, source: "unknown-library", uses: 4, variant: null, props: { "Label#1:0": { key: "Label#1:0", type: "TEXT", observed: ["Hi"] } } }] });
  put(path.join(exp, "libraries", "index.json"), { libraries: [{ dir: "acme-ui", libraryName: "Acme UI", file: "Acme UI", collectionKeys: [], counts: {} }], generatedAt: stamp.exportedAt });
  put(path.join(libDir, "components.json"), { ...stamp, file: "Acme UI", source: "library", components: [{ name: "Surface Avatar", id: "5:5", type: "COMPONENT", key: "k-lib", page: "Library", pageId: "0:1", props: label }] });
  const extra = put(path.join(root, "other", "components.json"), { ...stamp, components: [{ name: "Surface Badge", id: "7:7", type: "COMPONENT", key: "k-extra" }] });
  const entry = (key: string, name: string) => ({ figma: { key, name }, code: { module: "@/ui", export: name.replace(/\W/g, "") }, status: "active" });
  const mapFile = put(path.join(root, "map.json"), { version: 1, components: { "k-local": entry("k-local", "Brand Button"), "k-sample": entry("k-sample", "Surface Chip"), "k-lib": entry("k-lib", "Surface Avatar"), "k-extra": entry("k-extra", "Surface Badge") } });
  const orphanOf = (r: ReturnType<typeof run>, key: string) => new RegExp(`\\[orphaned-entry\\] map entry '${key}'`).test(r.stderr);

  const withExtra = run("drift-lint.js", [mapFile, named, "--catalog", extra]);
  const noExtraRun = () => run("drift-lint.js", [mapFile, named]); // no --catalog: runs on HEAD too (the flag is new)
  check("drift-lint: an entry keyed to a components.library.json component is mapped, not orphaned", withExtra.status === 0 && !orphanOf(withExtra, "k-sample") && !orphanOf(noExtraRun(), "k-sample"));
  check("drift-lint: an entry keyed to a libraries/<dir>/components.json component is mapped, not orphaned", withExtra.status === 0 && !orphanOf(withExtra, "k-lib") && !orphanOf(noExtraRun(), "k-lib"));
  check("drift-lint: --catalog adds a catalog; all four entries resolve, exit 0", withExtra.status === 0 && !/orphaned-entry/.test(withExtra.stderr) && /\+3 map entries resolved in the other catalog/.test(withExtra.stderr));
  check("drift-lint prints ONE line naming every catalog read",
    withExtra.stderr.split("\n").filter((l) => /^catalogs read \(4\): /.test(l) && l.includes("components.local.json [named") && l.includes("components.library.json [library-sample") && l.includes(path.join("acme-ui", "components.json") + " [library") && l.includes("other" + path.sep + "components.json [extra")).length === 1);
  const noExtra = run("drift-lint.js", [mapFile, named]);
  check("without --catalog, the entry only that catalog holds is still orphaned (exit 1)", noExtra.status === 1 && orphanOf(noExtra, "k-extra") && !orphanOf(noExtra, "k-lib"));
  const twoExtra = run("drift-lint.js", [mapFile, named, "--catalog", extra, "--catalog", put(path.join(root, "other", "more.json"), { ...stamp, components: [{ name: "Surface Tag", id: "8:8", type: "COMPONENT", key: "k-more" }] })]);
  check("--catalog is repeatable", /catalogs read \(5\)/.test(twoExtra.stderr) && twoExtra.status === 0);
  const absent = put(path.join(root, "absent.json"), { version: 1, components: { "k-gone": entry("k-gone", "Surface Gone") } });
  const gone = run("drift-lint.js", [absent, named, "--catalog", extra]);
  check("a key in NO catalog is still orphaned-entry, exit 1", gone.status === 1 && orphanOf(gone, "k-gone"));
  check("the same key in two catalogs is not a duplicate-key warning (one component seen twice)", (() => {
    const dup = put(path.join(root, "other", "dup.json"), { ...stamp, components: [{ name: "Surface Avatar", id: "5:5", type: "COMPONENT", key: "k-lib" }] });
    const r = run("drift-lint.js", [mapFile, named, "--catalog", extra, "--catalog", dup]);
    return r.status === 0 && !/duplicate-key/.test(r.stderr);
  })());

  // On the built script: 0% by map → warn + confirm, exit 0; the same run with an orphan → exit 1.
  const inst = (id: string, name: string, key: string) => ({ type: "INSTANCE", id, name, props: { "Label#1:0": "Hi" }, mainComponent: { name, key } });
  const screenFile = (f: string, kids: unknown[]) => put(path.join(root, f), { exportedAt: stamp.exportedAt, screen: "Home", nodes: [{ type: "FRAME", id: "1:0", name: "Home", children: kids }] });
  const foreign = screenFile("foreign.json", [inst("2:1", "Foreign Thing", "k-foreign-1"), inst("2:2", "Foreign Other", "k-foreign-2")]);
  const emptyMap = put(path.join(root, "empty.json"), { version: 1, components: {} });
  const zero = run("drift-lint.js", [emptyMap, named, "--screen", foreign]);
  check("0% screen coverage: exit 0 and a `warn   [screen-coverage]` line ending in a Confirm question",
    zero.status === 0 && /^warn {3}\[screen-coverage\] NONE/m.test(zero.stderr) && /Confirm: is .*the component library this screen is built from\? Until confirmed, build every instance as new\./.test(zero.stderr) && !/^ERROR/m.test(zero.stderr));
  check("the 0% advice still says the library export is CLI-only (the MCP server has no library export)",
    /dtwin pull --as-library "<name>"` \(CLI only — the MCP server has no library export\)/.test(zero.stderr));
  const rekeyCat = put(path.join(root, "rekey-cat.json"), { ...stamp, components: ["Brand Alpha", "Brand Beta", "Brand Gamma"].map((n, i) => ({ name: n, id: `9:${i}`, type: "COMPONENT", key: `k-old-${i}`, props: label })) });
  const rekeyScreen = screenFile("rekey.json", ["Brand Alpha", "Brand Beta", "Brand Gamma"].map((n, i) => inst(`3:${i}`, n, `k-new-${i}`)));
  const rk = run("drift-lint.js", [emptyMap, rekeyCat, "--screen", rekeyScreen]);
  check("catalog-rekeyed: exit 0 and a `warn   [catalog-rekeyed]` line ending in a Confirm question",
    rk.status === 0 && /^warn {3}\[catalog-rekeyed\] NONE/m.test(rk.stderr) && /Confirm: 3 component\(s\) match the catalog by name and prop signature but not by key .*\?/.test(rk.stderr) && !/^ERROR/m.test(rk.stderr));
  const orphanZero = run("drift-lint.js", [absent, named, "--screen", foreign]);
  check("an orphaned entry still exits 1 (with the 0% warning beside it)", orphanZero.status === 1 && /^ERROR  \[orphaned-entry\]/m.test(orphanZero.stderr) && /^warn {3}\[screen-coverage\]/m.test(orphanZero.stderr));
  const invalid = run("drift-lint.js", [put(path.join(root, "bad-map.json"), { version: 1, components: { X: { figma: {} } } }), named, "--screen", foreign]);
  check("an invalid map still exits 1", invalid.status === 1 && /\[map-invalid\]/.test(invalid.stderr));

  // map-bootstrap --screen stubs the library components the screen uses (it scoped the named catalog alone).
  const libScreen = screenFile("lib-screen.json", [inst("4:1", "Surface Avatar", "k-lib"), inst("4:2", "Surface Chip", "k-sample"), inst("4:3", "Brand Button", "k-local")]);
  const boot = run("map-bootstrap.js", [named, "--screen", libScreen]);
  const booted = ((): CodeConnectMap | null => { try { const m: unknown = JSON.parse(boot.stdout); return isCodeConnectMap(m) ? m : null; } catch { return null; } })();
  check("map-bootstrap --screen stubs library-only components the screen uses (components.json and components.library.json)",
    boot.status === 0 && !!booted && ["k-lib", "k-sample", "k-local"].every((k) => !!booted.components[k]) && Object.keys(booted.components).length === 3 && /2 of them from a library catalog/.test(boot.stderr));
  check("map-bootstrap names every catalog it read", /map-bootstrap: catalogs read \(3\)/.test(boot.stderr));
  const bootExtra = run("map-bootstrap.js", [named, "--screen", screenFile("extra-screen.json", [inst("5:1", "Surface Badge", "k-extra")]), "--catalog", extra]);
  check("map-bootstrap --catalog (repeatable flag) adds a catalog --screen can stub from", bootExtra.status === 0 && /"k-extra"/.test(bootExtra.stdout));
  // Node ids are per FILE. A library row with the same id as a deleted local component
  // must not resolve the entry (by figma.id, or by an id-shaped map key).
  const idRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dt26-id-"));
  const idDs = path.join(idRoot, "design", "export", "design-system"), idLib = path.join(idRoot, "design", "export", "libraries", "acme-ui");
  fs.mkdirSync(idDs, { recursive: true }); fs.mkdirSync(idLib, { recursive: true });
  const idNamed = put(path.join(idDs, "components.local.json"), { ...stamp, components: [{ name: "Brand Button", id: "1:1", type: "COMPONENT" }] });
  put(path.join(idRoot, "design", "export", "libraries", "index.json"), { libraries: [{ dir: "acme-ui", libraryName: "Acme UI", collectionKeys: [], counts: {} }], generatedAt: stamp.exportedAt });
  put(path.join(idLib, "components.json"), { ...stamp, file: "Acme UI", components: [{ name: "Surface Toggle", id: "1:5", type: "COMPONENT", key: "k-toggle" }] });
  const byDeclaredId = put(path.join(idRoot, "map-id.json"), { version: 1, components: { "local-switch": { figma: { id: "1:5", name: "Brand Switch" }, code: { module: "@/ui", export: "Switch" }, status: "active" } } });
  const byMapKeyId = put(path.join(idRoot, "map-key.json"), { version: 1, components: { "1:5": { figma: { name: "Brand Switch" }, code: { module: "@/ui", export: "Switch" }, status: "active" } } });
  const r1 = run("drift-lint.js", [byDeclaredId, idNamed]), r2 = run("drift-lint.js", [byMapKeyId, idNamed]);
  check("[id] an entry whose figma.id collides with a LIBRARY row's id is still orphaned-entry, exit 1 (ids are per file)",
    /catalogs read \(2\)/.test(r1.stderr) && r1.status === 1 && orphanOf(r1, "local-switch"));
  check("[id] …and so is an id-shaped map key with no figma identity", r2.status === 1 && orphanOf(r2, "1:5"));
  const idScreen = put(path.join(idRoot, "s.json"), { exportedAt: stamp.exportedAt, screen: "Home", nodes: [{ type: "FRAME", id: "1:0", name: "Home", children: [inst("2:1", "Surface Toggle", "k-toggle")] }] });
  const idBoot = run("map-bootstrap.js", [idNamed, byDeclaredId, "--screen", idScreen]);
  const idMap = ((): CodeConnectMap | null => { try { const m: unknown = JSON.parse(idBoot.stdout); return isCodeConnectMap(m) ? m : null; } catch { return null; } })();
  check("[id] map-bootstrap --screen: a library component is stubbed by KEY, never merged into the local entry that shares its id",
    !!idMap && !!idMap.components["k-toggle"] && idMap.components["k-toggle"]?.figma.id === undefined && idMap.components["local-switch"]?.figma.name === "Brand Switch" && idMap.components["local-switch"]?.figma.key === undefined);
  // Re-running a bootstrap over a map that already holds a LIBRARY entry must not merge
  // a keyed local component into it through a shared node id (it would re-point the mapping).
  const mixedCat = put(path.join(idRoot, "mixed-local.json"), { ...stamp, components: [{ name: "Brand Widget", id: "1:5", type: "COMPONENT", key: "k-local" }] });
  const mixedMap = put(path.join(idRoot, "map-mixed.json"), { version: 1, components: { "k-toggle": { figma: { key: "k-toggle", id: "1:5", name: "Surface Toggle" }, code: { module: "@/ui/Toggle", export: "Toggle" }, status: "active" } } });
  const mixedBoot = run("map-bootstrap.js", [mixedCat, mixedMap]);
  const mixed = ((): CodeConnectMap | null => { try { const m: unknown = JSON.parse(mixedBoot.stdout); return isCodeConnectMap(m) ? m : null; } catch { return null; } })();
  check("[merge] a bootstrap re-run never merges a keyed component into an entry with a DIFFERENT key that shares its id",
    mixedBoot.status === 0 && !!mixed && mixed.components["k-toggle"]?.figma.key === "k-toggle" && mixed.components["k-toggle"]?.figma.name === "Surface Toggle"
      && mixed.components["k-toggle"]?.code.module === "@/ui/Toggle" && !!mixed.components["k-local"]);
  // A full bootstrap never reads the other catalogs, so a broken one does not fail it.
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt26-broken-"));
  const brokenNamed = put(path.join(brokenDir, "components.local.json"), { ...stamp, components: [{ name: "Brand Button", id: "1:1", type: "COMPONENT", key: "k-local" }] });
  fs.writeFileSync(path.join(brokenDir, "components.library.json"), "{ not json");
  const brokenFull = run("map-bootstrap.js", [brokenNamed]);
  check("[full] a full bootstrap ignores a broken components.library.json beside the catalog (exit 0, as on HEAD)", brokenFull.status === 0 && /"k-local"/.test(brokenFull.stdout));
  // A DISCOVERED catalog is never asked for — a broken one is a warn naming it, then skipped
  // (as the MCP tool does); only a --catalog the user named fails loud.
  const brokenScreen = run("map-bootstrap.js", [brokenNamed, "--screen", idScreen]);
  check("[lenient] map-bootstrap --screen: a broken discovered components.library.json is a warn naming it, skipped (exit 0)",
    brokenScreen.status === 0 && /warn .*components\.library\.json is not a readable component catalog — skipped/.test(brokenScreen.stderr));
  const brokenMap = put(path.join(brokenDir, "map.json"), { version: 1, components: { "k-local": entry("k-local", "Brand Button") } });
  const brokenLint = run("drift-lint.js", [brokenMap, brokenNamed]);
  check("[lenient] drift-lint: the same broken discovered file is `warn   [catalog-unreadable] <file>` and the run goes on (exit 0, as on HEAD)",
    brokenLint.status === 0 && /^warn {3}\[catalog-unreadable\] .*components\.library\.json is not a readable component catalog — skipped/m.test(brokenLint.stderr));
  fs.writeFileSync(path.join(brokenDir, "named-extra.json"), "{ not json");
  check("[lenient] …but a broken --catalog the user NAMED still fails loud (exit 2)", run("drift-lint.js", [brokenMap, brokenNamed, "--catalog", path.join(brokenDir, "named-extra.json")]).status === 2);
  // A duplicate key inside an extra catalog names that file.
  const dupInside = put(path.join(root, "other", "dup-inside.json"), { ...stamp, components: [{ name: "Surface A", id: "9:1", type: "COMPONENT", key: "k-dupin" }, { name: "Surface B", id: "9:2", type: "COMPONENT", key: "k-dupin" }] });
  check("[dupfile] a duplicate key inside an extra catalog names that file",
    new RegExp(`duplicate-key\\] two catalog components share key 'k-dupin' \\('Surface A' and 'Surface B'\\) in ${dupInside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(run("drift-lint.js", [mapFile, named, "--catalog", dupInside]).stderr));
  // A confirmed proposal WITH a key binds by key only — never to a local component that
  // happens to share its (other file's) node id.
  const idLocal = put(path.join(idDs, "components.local.json"), { ...stamp, components: [{ name: "Local Widget", id: "1:5", type: "COMPONENT", key: "k-local-widget" }] });
  const proposals = put(path.join(idRoot, "proposals.json"), [{ name: "Surface Toggle", instanceKeys: ["inst-1"], catalog: { key: "k-toggle", id: "1:5", name: "Surface Toggle", type: "COMPONENT" }, confirmed: true, reasons: [], alternatives: [] }]);
  const prop = run("map-bootstrap.js", [idLocal, "--from-proposals", proposals]);
  const propMap = ((): CodeConnectMap | null => { try { const m: unknown = JSON.parse(prop.stdout); return isCodeConnectMap(m) ? m : null; } catch { return null; } })();
  check("[prop] --from-proposals: a keyed library proposal binds to the library component by key, not to the local '1:5'",
    prop.status === 0 && propMap?.components["inst-1"]?.figma.key === "k-toggle" && propMap.components["inst-1"]?.figma.name === "Surface Toggle");
  const full = run("map-bootstrap.js", [named]);
  check("a full bootstrap (no --screen) still stubs the named catalog only — not every library component", (() => { try { const m: unknown = JSON.parse(full.stdout); return isCodeConnectMap(m) && Object.keys(m.components).join() === "k-local"; } catch { return false; } })());
})();

// ---------- map-bootstrap.js --screen scopes the catalog to what one screen actually uses ----------
// A full bootstrap on a real catalog would stub EVERY component in it (59 here, 318 on
// a real file) regardless of the screen about to be built — a confirm list nobody can evaluate.
// --screen filters that down to the keys/ids the screen's own VISIBLE instances reference.
(() => {
  const D2C = path.join(import.meta.dirname, "..", "design-to-code");
  const FXL = path.join(import.meta.dirname, "fixtures", "livetest3");
  const catalog = path.join(FXL, "design-system", "components.local.json");
  const screen = path.join(FXL, "pages", "__Optimization_management_", "positions___7314_87192.json");
  const asMap = (stdout: string): CodeConnectMap => { const m: unknown = JSON.parse(stdout); return must(isCodeConnectMap(m) ? m : null, "map-bootstrap to print a valid map"); };
  const full = asMap(spawnSync(process.execPath, [path.join(D2C, "map-bootstrap.ts"), catalog], { encoding: "utf8" }).stdout);
  const scopedRun = spawnSync(process.execPath, [path.join(D2C, "map-bootstrap.ts"), catalog, "--screen", screen], { encoding: "utf8" });
  const scoped = asMap(scopedRun.stdout);
  const fullCount = Object.keys(full.components).length;
  const scopedCount = Object.keys(scoped.components).length;
  // This fixture screen is the 0%-catalog-match case (0 of the screen's
  // instance keys are in this catalog), so the scoped count is legitimately 0 — the point is that it
  // is never the full 59, i.e. it never asks the user to confirm components the screen doesn't use.
  check("[map-bootstrap --screen] scopes to fewer components than a full bootstrap", scopedCount < fullCount);
  // the "from" side is every catalog read (this fixture's components.library.json too), so it is >= the full bootstrap's count.
  check("[map-bootstrap --screen] says on stderr how much it scoped, from -> to", Number((new RegExp(`from (\\d+) to ${scopedCount} `).exec(scopedRun.stderr) || [])[1]) >= fullCount);
})();

// ---------- a consumer-project path that does not exist in a consumer project --------
// `design-to-code/<script>.js` is only a valid path INSIDE this repo. A consumer project has only
// the plugin's own `${CLAUDE_PLUGIN_ROOT}/scripts/<script>.js` — a skill quoting the repo-relative
// path hands the model a command that fails with `Cannot find module` the moment it runs. Comments
// inside the GENERATED claude-plugin/scripts/*.js (the build banner, which legitimately says where
// the source lives) and help/references/troubleshooting.md's explicit "working from a clone of the
// repo instead" alternative are the only allowed exceptions; neither is a *.md under skills/ or
// agents/ telling the model what command to run.
(() => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".md") ? [path.join(d, e.name)] : []);
  const PLUGIN_ROOT = path.join(import.meta.dirname, "..", "claude-plugin");
  const offenders: string[] = [];
  for (const f of [...walk(path.join(PLUGIN_ROOT, "skills")), ...walk(path.join(PLUGIN_ROOT, "agents"))]) {
    const rel = path.relative(PLUGIN_ROOT, f);
    if (rel === path.join("skills", "help", "references", "troubleshooting.md")) continue; // explicit "cloned repo" alternative, not a command to run in a consumer project
    const text = fs.readFileSync(f, "utf8");
    if (/design-to-code\//.test(text)) offenders.push(rel);
  }
  check("no skill/agent doc quotes the repo-relative design-to-code/ path — every script is ${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js" +
    (offenders.length ? " — offenders: " + offenders.join(", ") : ""), offenders.length === 0);
})();

// ---------- every script command resolves to a real path ------------------------------
// `${CLAUDE_PLUGIN_ROOT}` is substituted into skill/agent Markdown when Claude Code loads it, but it is not
// an environment variable in the Bash tool, a skill preloaded into an agent kept it literal, and a
// references/*.md opened with Read is never substituted — so commands built on it ran with an empty path in
// both field runs. No bin/ launcher: claude.ai and Cowork refuse a plugin with a top-level bin/
// (https://code.claude.com/docs/en/plugins-reference, "Standard layout"). Instead: skill/agent bodies say
// `${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js` (substituted there), references/profiles say `<scripts>/…`
// defined by their SKILL.md, the agent that preloads a skill names the folder itself, and every usage line
// or printed hint carries the script's own real path.
(() => {
  const PLUGIN_ROOT = path.join(import.meta.dirname, "..", "claude-plugin");
  const REPO = path.join(PLUGIN_ROOT, "..");
  const SCRIPTS = path.join(PLUGIN_ROOT, "scripts");
  const entries = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".md") ? [path.join(d, e.name)] : []);
  const docs = [...walk(path.join(PLUGIN_ROOT, "skills")), ...walk(path.join(PLUGIN_ROOT, "agents"))];
  const isBody = (f: string) => path.basename(f) === "SKILL.md" || f.includes(`${path.sep}agents${path.sep}`);
  const lines = (f: string) => fs.readFileSync(f, "utf8").split("\n");

  check("the plugin has no top-level bin/ (claude.ai and Cowork refuse to install such a plugin)", !fs.existsSync(path.join(PLUGIN_ROOT, "bin")));

  const unknown: string[] = [], rootInReadFile: string[] = [], undefinedPlaceholder: string[] = [];
  for (const f of docs) {
    const rel = path.relative(PLUGIN_ROOT, f);
    lines(f).forEach((line, i) => {
      for (const m of line.matchAll(/(?:\$\{CLAUDE_PLUGIN_ROOT\}|<scripts>)\/scripts\/([a-z][a-z0-9-]*)\.js|<scripts>\/([a-z][a-z0-9-]*)\.js/g)) {
        const n = m[1] ?? m[2] ?? "";
        if (!entries.includes(n)) unknown.push(`${rel}:${i + 1} ${n}`);
      }
      if (!isBody(f) && line.includes("${CLAUDE_PLUGIN_ROOT}")) rootInReadFile.push(`${rel}:${i + 1}`);
    });
  }
  // A read-as-is file that says <scripts>/<plugin> needs EVERY SKILL.md that sends the model to it — its own
  // skill's, and any other skill that loads it by name (sync-design and audit-design load build-screen's
  // profiles and export-layout.md; extract loads help's troubleshooting.md) — to say what that means.
  const placeholderFiles = docs.filter((f) => !isBody(f)).map((f) => {
    const text = fs.readFileSync(f, "utf8");
    return { f, rel: path.relative(PLUGIN_ROOT, f), scripts: text.includes("<scripts>"), plugin: text.includes("<plugin>/") };
  }).filter((x) => x.scripts || x.plugin);
  for (const skillMd of docs.filter((f) => path.basename(f) === "SKILL.md")) {
    const def = fs.readFileSync(skillMd, "utf8");
    const own = path.dirname(skillMd);
    for (const pf of placeholderFiles) {
      const isProfile = pf.rel.split(path.sep).includes("profiles");
      const loads = pf.f.startsWith(own + path.sep) || def.includes(path.basename(pf.f)) || (isProfile && def.includes("profiles/"));
      if (!loads) continue;
      const where = `${path.relative(PLUGIN_ROOT, skillMd)} → ${pf.rel}`;
      if (pf.scripts && !(def.includes("`<scripts>`") && def.includes("${CLAUDE_PLUGIN_ROOT}/scripts"))) undefinedPlaceholder.push(`${where} (<scripts>)`);
      if (pf.plugin && !(def.includes("`<plugin>`") && def.includes("${CLAUDE_PLUGIN_ROOT}"))) undefinedPlaceholder.push(`${where} (<plugin>)`);
    }
  }
  check("every script a doc names (${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js or <scripts>/<name>.js) is one the plugin ships" + (unknown.length ? " — " + unknown.join(", ") : ""), unknown.length === 0);
  check("no references/ or profiles/ file relies on ${CLAUDE_PLUGIN_ROOT} (a file opened with Read is never substituted)" +
    (rootInReadFile.length ? " — " + rootInReadFile.join(", ") : ""), rootInReadFile.length === 0);
  check("every SKILL.md that loads a file using <scripts>/<plugin> (its own or another skill's) defines it as the substituted plugin path" +
    (undefinedPlaceholder.length ? " — " + undefinedPlaceholder.join(", ") : ""), undefinedPlaceholder.length === 0);
  // the agent that PRELOADS build-screen (whose body then stays literal) names the folder in its own,
  // substituted prompt.
  const builder = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "screen-builder.md"), "utf8");
  check("screen-builder preloads build-screen and names the scripts folder itself (${CLAUDE_PLUGIN_ROOT}/scripts/ in its own prompt)",
    /skills:\s*\n\s*-\s*build-screen/.test(builder) && builder.split("---").slice(2).join("---").includes("${CLAUDE_PLUGIN_ROOT}/scripts/"));

  // Sources: usage lines and printed hints give the real path; nothing prints the unsubstituted variable,
  // and no hint names a bare `<script>.js` (command not found in a consumer project).
  const D2C_DIR = path.join(REPO, "design-to-code");
  const NAMES = entries.join("|");
  const bare = new RegExp("(?<![\\w/.-])(" + NAMES + ")\\.js\\b");
  // verify-screen's expectation `note` is written into every <screen>.expected.json: its text is part of the
  // file's sha256 (reports and probes record it), so it keeps its original wording.
  const DATA_TEXT = ["with `verify-screen.js --compare`; the probe's field names"];
  const inSources: string[] = [], hints: string[] = [];
  for (const f of fs.readdirSync(D2C_DIR).filter((x) => x.endsWith(".ts"))) {
    lines(path.join(D2C_DIR, f)).forEach((line, i) => {
      if (/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//.test(line)) inSources.push(`${f}:${i + 1}`);
      const s = line.trimStart();
      if (/^(\/\/|\*|\/\*|import )/.test(s) || line.includes("GENERATED by Design Twin") || DATA_TEXT.some((d) => line.includes(d))) return;
      if (bare.test(line.split(" // ")[0] ?? "")) hints.push(`${f}:${i + 1}`);
    });
  }
  check("no design-to-code source prints ${CLAUDE_PLUGIN_ROOT}/scripts/… (usage and hints use scriptCmd → the real path)" +
    (inSources.length ? " — " + inSources.join(", ") : ""), inSources.length === 0);
  check("no script output tells the model to run a bare `<script>.js`" + (hints.length ? " — " + hints.join(", ") : ""), hints.length === 0);

  // The shipped bundles print THEIR OWN folder: run from an unrelated cwd, the usage path and a sibling
  // script named in a hint both exist.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-paths-"));
  const help = spawnSync(process.execPath, [path.join(SCRIPTS, "tokens.js"), "--help"], { cwd: tmp, encoding: "utf8" });
  const usagePath = /usage: node "([^"]+)"/.exec(help.stdout)?.[1];
  check("the shipped tokens.js --help prints its own real path (node \"…/scripts/tokens.js\"), from any cwd",
    help.status === 0 && usagePath === path.join(SCRIPTS, "tokens.js") && fs.existsSync(usagePath));
  fs.writeFileSync(path.join(tmp, "map.json"), "{}");
  fs.writeFileSync(path.join(tmp, "cat.json"), JSON.stringify({ components: [] }));
  const lint = spawnSync(process.execPath, [path.join(SCRIPTS, "drift-lint.js"), "map.json", "cat.json"], { cwd: tmp, encoding: "utf8" });
  const hintPath = /node "([^"]+map-validate\.js)"/.exec(lint.stderr)?.[1];
  check("a hint the shipped drift-lint.js prints names the sibling script by its real path (…/scripts/map-validate.js)",
    hintPath === path.join(SCRIPTS, "map-validate.js") && fs.existsSync(hintPath));
  fs.rmSync(tmp, { recursive: true, force: true });
})();

// ---------- helpers shared across files (one definition each) ----------
{
  check("[shared] isRecord: an object yes; null, an array, a string, a number no", isRecord({}) && isRecord({ a: 1 }) && !isRecord(null) && !isRecord([]) && !isRecord("x") && !isRecord(1));
  const withCode = Object.assign(new Error("boom"), { code: "ENOENT" });
  check("[shared] errCode: a string code of an error object; undefined for no code, a non-string code, null, a string",
    errCode(withCode) === "ENOENT" && errCode(new Error("x")) === undefined && errCode({ code: 7 }) === undefined && errCode(null) === undefined && errCode("ENOENT") === undefined);
  check("[shared] firstLine: only the first line of a message (an Error, a string, an object with .message); empty for an empty message",
    firstLine(new Error("a\nb\nc")) === "a" && firstLine("one\ntwo") === "one" && firstLine({ message: "m\nn" }) === "m" && firstLine("") === "");
  check("[shared] errMsg: a thrown string is itself; an Error is its message", errMsg("s") === "s" && errMsg(new Error("e")) === "e");
  check("[shared] sha256Hex: the known digest of 'abc', the same for a string and its bytes", sha256Hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" && sha256Hex(Buffer.from("abc")) === sha256Hex("abc"));
  check("[shared] alnumKey: case and punctuation folded away, null/undefined empty", alnumKey("Primary / Fill-2") === "primaryfill2" && alnumKey(null) === "" && alnumKey(undefined) === "");
  check("[shared] isAlias: {aliasOf: string} only", isAlias({ aliasOf: "a/b" }) && !isAlias({ aliasOf: 1 }) && !isAlias("a/b") && !isAlias(null));
  check("[shared] isComposed (strict): both halves valid and one an alias; a literal pair or a missing half is not composed",
    isComposed({ composed: { color: { aliasOf: "c" }, opacity: 0.5 } }) && isComposed({ composed: { color: "#fff", opacity: { aliasOf: "o" } } })
    && !isComposed({ composed: { color: "#fff", opacity: 0.5 } }) && !isComposed({ composed: { color: { aliasOf: "c" } } }) && !isComposed({ composed: null }) && !isComposed("composed"));
  check("[shared] NUMERIC_TEXT: signed decimals as text; not an exponent, a unit or an empty string", NUMERIC_TEXT.test("40") && NUMERIC_TEXT.test("-5") && NUMERIC_TEXT.test("12.5") && !NUMERIC_TEXT.test("1e3") && !NUMERIC_TEXT.test("40px") && !NUMERIC_TEXT.test(""));
  check("[shared] probe-match exports: PAINT_TYPES, idSuffix, normText (U+00A0 and runs of space folded)",
    PAINT_TYPES.has("VECTOR") && !PAINT_TYPES.has("FRAME") && idSuffix("I1:2;3:4;5:6") === "3:4;5:6" && idSuffix("1:2") === null && normText(" a\u00a0 b\n c ") === "a b c");
  // pages-layout's guard accepts arrays: a previous index that is an array is merged over, its elements landing under their indices
  const merged = mergeScreenIndex(["x"], { name: "A", id: "2:1", page: "P", pageId: "1:1", file: "a.json" });
  check("[shared] mergeScreenIndex over an array index keeps its elements (its guard accepts arrays, unlike isRecord)", merged["0"] === "x" && Array.isArray(merged.layers) && merged.layers.length === 1);
  // raceBudget: the value of work that beats the deadline; a cut (onCut first, then a settle for the close and work) when it
  // does not — settled false when the settle window runs out (a wedged browser), true when a slow close still returns
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  let cuts = 0;
  const fast = await raceBudget(sleep(5).then(() => 7), 500, {}, () => { cuts++; });
  check("[shared] raceBudget: work that finishes inside the deadline returns its value and never calls onCut", !fast.cut && fast.value === 7 && cuts === 0);
  const cutLike = await raceBudget(Promise.resolve("cut"), 500, {});
  check("[shared] raceBudget: work whose value is the string 'cut' is its value, not a cut", !cutLike.cut && cutLike.value === "cut");
  let settled = false;
  const t0 = Date.now();
  const slow = await raceBudget(sleep(120).then(() => { settled = true; return 1; }), 30, {}, () => { cuts++; });
  check("[shared] raceBudget: past the deadline it returns a settled cut, has called onCut once, and waited for work to settle (well under CUT_SETTLE_MS)",
    slow.cut && slow.settled && cuts === 1 && settled && Date.now() - t0 < CUT_SETTLE_MS);
  // the wedge paths, a slow-but-alive close and a context that arrives after the cut run side by side: one CUT_SETTLE_MS wait for all
  const SLOW_CLOSE_MS = 2_000;
  let closes = 0;
  // the settle wait is unref'd (in the probe the browser's pipe keeps the process alive): this interval stands in for it
  const keepAlive = setInterval(() => undefined, 1000);
  const tw = Date.now();
  // a context created after the cut (a loaded browser's slow newContext), as openReached does it: holdContext gets it, then the
  // unit waits in it (a page load) until the context closes — nobody else closes it
  let lateClosed = false;
  const late: Held = {};
  const lateWork = (async (): Promise<string> => {
    await sleep(200);
    let closedNow: () => void = () => undefined;
    const closedP = new Promise<void>((r) => { closedNow = r; });
    holdContext(late)({ close: async () => { lateClosed = true; closedNow(); } });
    await Promise.race([closedP, sleep(30_000)]);
    return lateClosed ? "closed" : "ran on";
  })();
  // the same through driveInteractions: newContext answers 200 ms after a 100 ms budget; its page waits until the context closes
  let driveCtxClosed = false;
  const isContext = (x: unknown): x is BrowserContext => typeof x === "object" && x !== null && "close" in x && "newPage" in x;
  const slowContext = async (): Promise<BrowserContext> => {
    await sleep(200);
    let closedNow: () => void = () => undefined;
    const closedP = new Promise<void>((r) => { closedNow = r; });
    const fake = { close: async (): Promise<void> => { driveCtxClosed = true; closedNow(); },
      newPage: async (): Promise<never> => { await Promise.race([closedP, sleep(30_000)]); throw new Error("Target page, context or browser has been closed"); } };
    if (!isContext(fake)) throw new Error("fake context");
    return fake;
  };
  const [wedge, alive, noCtx, timed, closeHung, lateCut, straddle] = await Promise.all([
    raceBudget(never<number>(), 20, { ctx: { close: () => { closes++; return never<void>(); } } }).then((r) => ({ ...r, ms: Date.now() - tw })),
    (async () => { let open = true; const work = (async (): Promise<number> => { while (open) await sleep(20); return 1; })();
      const r = await raceBudget(work, 20, { ctx: { close: async () => { await sleep(SLOW_CLOSE_MS); open = false; } } });
      return { ...r, ms: Date.now() - tw }; })(),
    raceBudget(never<number>(), 20, {}).then((r) => ({ ...r, ms: Date.now() - tw })),
    driveInteractions({ newContext: () => never() }, { rows: [{ nodeId: "1:1", name: "Open", trigger: "ON_CLICK" }, { nodeId: "1:2", name: "More", trigger: "ON_CLICK" }], viewport: { w: 100, h: 100 }, timeout: 100, initScript: "", budgetMs: 20, reach: async () => undefined })
      .then((r) => ({ ...r, ms: Date.now() - tw })),
    raceBudget(sleep(100).then(() => 1), 20, { ctx: { close: () => never<void>() } }),
    raceBudget(lateWork, 100, late).then((r) => ({ ...r, ms: Date.now() - tw })),
    driveInteractions({ newContext: slowContext }, { rows: [{ nodeId: "2:1", name: "Open", trigger: "ON_CLICK" }], viewport: { w: 100, h: 100 }, timeout: 30_000, initScript: "", budgetMs: 100, reach: async () => undefined })
      .then((r) => ({ ...r, ms: Date.now() - tw })),
  ]);
  clearInterval(keepAlive);
  check("[shared] raceBudget: a hung close and hung work → a cut that did not settle, returned at CUT_SETTLE_MS (not later)",
    wedge.cut && !wedge.settled && closes === 1 && wedge.ms >= CUT_SETTLE_MS && wedge.ms < CUT_SETTLE_MS + 3_000);
  check("[shared] raceBudget: a slow close that returns inside CUT_SETTLE_MS → a settled cut, not a wedge", alive.cut && alive.settled && alive.ms >= SLOW_CLOSE_MS && alive.ms < CUT_SETTLE_MS);
  check("[shared] raceBudget: no context and work that never ends → a cut that did not settle", noCtx.cut && !noCtx.settled);
  check("[shared] raceBudget: a close that never returns is a wedge even when work itself ended", closeHung.cut && !closeHung.settled);
  check("[shared] holdContext: a context that arrives after the cut is closed as it arrives, so the cut settles (no wedge) well inside CUT_SETTLE_MS",
    lateCut.cut && lateCut.settled && lateClosed && lateCut.ms < CUT_SETTLE_MS);
  check("[shared] driveInteractions: a newContext that answers after the row's cut → its context is closed, not wedged, the row time budget",
    !straddle.wedged && driveCtxClosed && straddle.ms < CUT_SETTLE_MS && straddle.evidence[0]?.cut === "budget");
  check("[shared] driveInteractions: a browser that never answers → wedged, by about budget + CUT_SETTLE_MS; the cut row is time budget, the rest not driven",
    timed.wedged && timed.ms < CUT_SETTLE_MS + 3_000 && timed.evidence.length === 2
    && timed.evidence[0]?.cut === "budget" && timed.evidence[1]?.detail === "not-run: the browser stopped answering");
  const outW = driveOutcome({ evidence: timed.evidence, wedged: true }), outOk = driveOutcome({ evidence: timed.evidence, wedged: false });
  check("[shared] driveOutcome: a wedged drive keeps no evidence, sets wedged and says the browser stopped answering; an unwedged one keeps its evidence",
    outW.wedged && outW.driven === null && /the browser stopped answering/.test(outW.driveNote ?? "") && !outOk.wedged && outOk.driven === timed.evidence && outOk.driveNote === null);
  // a rejecting work propagates, and its deadline timer is cleared (otherwise this ref'd 60 s timer would hold the process open)
  const refTimers = (): number => process.getActiveResourcesInfo().filter((t) => t === "Timeout").length;
  const timersBefore = refTimers();
  const rejected = await raceBudget(Promise.reject(new Error("boom")), 60_000, {}).then(() => "resolved", (e: unknown) => errMsg(e));
  check("[shared] raceBudget: a work that rejects propagates the rejection and leaves no ref'd deadline timer behind", rejected === "boom" && refTimers() === timersBefore);
}

// ---------- the four hand-parsed CLIs share cliParse: --flag=value, every unknown flag, no stray words ---------
// map-bootstrap, get-component, resolve-screen and verify-build used to take argv by hand (indexOf + splice, or
// array destructuring), so `--out=x` was an unknown option, a single-dash typo became a positional, only the first
// unknown flag was named, and a surplus positional was ignored. Real subprocesses: the behaviour is the exit code
// and what lands on stderr. None binds a port.
(() => {
  const D2C = path.join(import.meta.dirname, "..", "design-to-code");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "d2c-cliargs-"));
  fs.writeFileSync(path.join(cwd, "c.json"), JSON.stringify(catalog([{ name: "Sample Button", id: "6:0", type: "COMPONENT_SET", key: "KEY_SAMPLE_BUTTON" },
    { name: "-Divider", id: "6:1", type: "COMPONENT", key: "KEY_DIVIDER" }, { name: "--- Section ---", id: "6:2", type: "COMPONENT", key: "KEY_SECTION" }])));
  fs.mkdirSync(path.join(cwd, "pages"));
  fs.writeFileSync(path.join(cwd, "pages", "index.json"), JSON.stringify({ pageDirs: [{ page: "P", dir: "P" }], layers: [
    { name: "Home", id: "1:2", type: "FRAME", page: "P", file: "pages/P/Home__1_2.json" },
    { name: "- Draft", id: "1:3", type: "FRAME", page: "P", file: "pages/P/Draft__1_3.json" },
    { name: "---", id: "1:4", type: "FRAME", page: "P", file: "pages/P/Rule__1_4.json" },
  ] }));
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [path.join(D2C, script), ...args], { encoding: "utf8", cwd, input: "" });
  const rejects = (script: string, args: string[], code: number, msg: RegExp): boolean => {
    const r = run(script, args);
    return r.status === code && msg.test(r.stderr) && /^usage: /m.test(r.stderr) && r.stdout === "";
  };
  const mb = "map-bootstrap.ts", gc = "get-component.ts", rs = "resolve-screen.ts", vb = "verify-build.ts";

  const eq = run(mb, ["c.json", "--out=eq.json"]);
  check("[cli-args] map-bootstrap takes --out=<file> as well as --out <file>", eq.status === 0 && fs.existsSync(path.join(cwd, "eq.json")) && eq.stdout === "");
  check("[cli-args] …and still takes the space-separated form, a repeated --catalog and the map before the flags",
    run(mb, ["--out", "sp.json", "--catalog", "c.json", "--catalog", "c.json", "c.json"]).status === 0 && fs.existsSync(path.join(cwd, "sp.json")));
  check("[cli-args] map-bootstrap names EVERY unknown flag, exit 1", rejects(mb, ["c.json", "--bogus", "--other"], 1, /^map-bootstrap: unknown flag --bogus, --other$/m));
  check("[cli-args] map-bootstrap rejects a single-dash typo instead of reading it as the existing map", rejects(mb, ["c.json", "-x"], 1, /^map-bootstrap: unknown flag -x$/m));
  check("[cli-args] map-bootstrap names a value that starts with '-' once, as typed, with the way out — not the letters Node splits it into",
    rejects(mb, ["c.json", "-Button"], 1, /^map-bootstrap: unknown flag -Button \(a value starting with "-": put -- before it, or use --flag=value\)$/m)
    && rejects(mb, ["c.json", "-h-thing"], 1, /^map-bootstrap: unknown flag -h-thing \(/m) && run(mb, ["c.json", "--", "-Button"]).stderr.includes("unexpected argument") === false);
  check("[cli-args] …alongside a long unknown flag, each once", rejects(mb, ["c.json", "--bogus", "-Button", "-Button"], 1, /^map-bootstrap: unknown flag --bogus, -Button \(/m));
  check("[cli-args] …and -hh is help, not a silently ignored flag", run(mb, ["-hh"]).status === 0 && /^usage: /m.test(run(mb, ["-hh"]).stdout)
    && run(vb, ["-hh"]).status === 0 && /^usage: /m.test(run(vb, ["-hh"]).stdout));
  check("[cli-args] a dash-leading word after a value-taking flag is that flag's missing value, not an unknown flag", rejects(mb, ["c.json", "--out", "-Button"], 1, /^map-bootstrap: --out needs a value$/m));
  check("[cli-args] map-bootstrap rejects a third positional (it was silently dropped)", rejects(mb, ["c.json", "a.json", "b.json"], 1, /^map-bootstrap: unexpected argument b\.json$/m));
  check("[cli-args] map-bootstrap: a value-taking flag with no value, or a flag as its value, says so", rejects(mb, ["c.json", "--out"], 1, /^map-bootstrap: --out needs a value$/m)
    && rejects(mb, ["c.json", "--out", "--screen", "s.json"], 1, /^map-bootstrap: --out needs a value$/m));
  check("[cli-args] map-bootstrap: an empty --out is no file name (it used to be taken for no --out and print to stdout)", rejects(mb, ["c.json", "--out", ""], 1, /^map-bootstrap: --out needs a value$/m));
  check("[cli-args] map-bootstrap: no catalog prints the usage, exit 1", run(mb, []).status === 1 && /^usage: /m.test(run(mb, []).stderr));

  check("[cli-args] get-component still resolves a handle", run(gc, ["c.json", "KEY_SAMPLE_BUTTON"]).status === 0);
  // get-component and resolve-screen have no flag but --help: a name that starts with "-" is a name, never parsed as flags
  const found = (script: string, args: string[], id: string): boolean => { const r = run(script, args); return r.status === 0 && r.stdout.includes(id); };
  check("[cli-args] get-component looks up a name that starts with '-' (it is not split into short flags)",
    found(gc, ["c.json", "-Divider"], "6:1") && found(gc, ["c.json", "--- Section ---"], "6:2") && found(gc, ["c.json", "KEY_DIVIDER"], "6:1"));
  check("[cli-args] …a leading -- is dropped, so `-- -Divider` works too", found(gc, ["c.json", "-Divider"], "6:1") && found(gc, ["--", "c.json", "-Divider"], "6:1"));
  const noMatch = (script: string, args: string[], what: RegExp): boolean => { const r = run(script, args); return r.status === 1 && what.test(r.stderr) && !/unknown flag|unexpected argument/.test(r.stderr); };
  check("[cli-args] get-component: --bogus, -x, -h-thing and -hh are names to look up (no match, exit 1), not flags",
    ["--bogus", "-x", "-h-thing", "-hh"].every((h) => noMatch(gc, ["c.json", h], new RegExp(`no component matches '${h}'`))));
  check("[cli-args] get-component rejects a third positional (it was ignored)", rejects(gc, ["c.json", "KEY_SAMPLE_BUTTON", "extra"], 2, /^get-component: unexpected argument extra$/m));
  check("[cli-args] get-component with one argument prints the usage, exit 2", run(gc, ["c.json"]).status === 2 && /^usage: /m.test(run(gc, ["c.json"]).stderr));

  check("[cli-args] resolve-screen still resolves, with and without the plan dir", run(rs, [".", "Home"]).status === 0 && run(rs, [".", "Home", "plan"]).status === 0);
  check("[cli-args] resolve-screen looks up a screen name that starts with '-' (it is not split into short flags)",
    found(rs, [".", "- Draft"], "1:3") && found(rs, [".", "---"], "1:4") && found(rs, ["--", ".", "- Draft"], "1:3"));
  check("[cli-args] resolve-screen: --bogus, -x, -h-thing and -hh are names to look up (no match, exit 1), not flags",
    ["--bogus", "-x", "-h-thing", "-hh"].every((h) => noMatch(rs, [".", h], new RegExp(`'${h}' matches no screen`))));
  check("[cli-args] resolve-screen rejects a fourth positional (it was ignored)", rejects(rs, [".", "Home", "plan", "extra"], 2, /^resolve-screen: unexpected argument extra$/m));
  check("[cli-args] resolve-screen with one argument prints the usage, exit 2", run(rs, ["."]).status === 2 && /^usage: /m.test(run(rs, ["."]).stderr));

  check("[cli-args] verify-build --status still runs (no plans is not an error)", run(vb, ["--status"]).status === 0);
  check("[cli-args] verify-build names every unknown flag, exit 2", rejects(vb, ["--a", "--b", "--status"], 2, /^verify-build: unknown flag --a, --b$/m));
  check("[cli-args] verify-build rejects a single-dash typo", rejects(vb, ["-x"], 2, /^verify-build: unknown flag -x$/m));
  check("[cli-args] verify-build names a value that starts with '-' once, as typed", rejects(vb, ["-Button"], 2, /^verify-build: unknown flag -Button \(a value starting with "-"/m)
    && rejects(vb, ["-h-thing"], 2, /^verify-build: unknown flag -h-thing \(/m));
  check("[cli-args] verify-build: a boolean flag given a value says it takes none", rejects(vb, ["--json=1"], 2, /^verify-build: --json takes no value$/m)
    && rejects(vb, ["--help=1"], 2, /^verify-build: --help takes no value$/m)
    && rejects(vb, ["--status=1"], 2, /^verify-build: --status takes no value$/m));
  fs.rmSync(cwd, { recursive: true, force: true });
})();

report();
