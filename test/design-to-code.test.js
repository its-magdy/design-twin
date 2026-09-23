// Offline tests for the design-to-code/ layer. No Figma, no dependencies:  node test/design-to-code.test.js
// Hardened after an adversarial review — assertions pin VALUES (not just presence) and every
// confirmed finding has a regression test. Tags: [Fn]/[An]/[Mn]/[Bn] map to review finding ids.
const { toDTCG, toCSS, toResolver, toTailwind, lintTokens, emitTokens, hexToColorValue, cssVarName } = require("../design-to-code/tokens");
const { validateMap } = require("../design-to-code/map-validate");
const { driftLint } = require("../design-to-code/drift-lint");
const { bootstrap } = require("../design-to-code/map-bootstrap");
const { isManifest } = require("../design-to-code/catalog-input");
const { getComponent, findComponent, resolveVariantsFile } = require("../design-to-code/get-component");
const { buildDesignSystemLayout } = require("../bridge/design-system-layout");
const { check, report } = require("./assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const near = (a, b) => Math.abs(a - b) < 0.001;

// ---------- clean design system (no collisions/danglers) for value assertions ----------
const ds = {
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
  components: [
    { name: "Button", id: "1:1", type: "COMPONENT", key: "KEY_BTN", props: {
      Variant: { key: "Variant", type: "VARIANT", options: ["Primary", "Secondary"], default: "Primary" },
      Disabled: { key: "Disabled", type: "BOOLEAN", default: false }, Label: { key: "Label", type: "TEXT" }, Icon: { key: "Icon", type: "INSTANCE_SWAP" } } },
    { name: "Card", id: "2:2", type: "COMPONENT", key: "KEY_CARD", props: {} },
  ],
};

// ---------- tokens: DTCG VALUES (M2: assert the actual channels, not just length) ----------
console.log("tokens — DTCG:");
const dtcg = toDTCG(ds);
const c600 = dtcg.blue["600"].$value.components;
check("[M2] primitive color RGB channels correct", near(c600[0], 0.1451) && near(c600[1], 0.3882) && near(c600[2], 0.9216) && dtcg.blue["600"].$value.hex === "#2563eb");
check("alias PRESERVED as reference", dtcg.color.primary.$value === "{blue.600}");
check("per-mode values under $extensions (figma.com)", dtcg.color.primary.$extensions["figma.com"].modes.Dark === "{blue.300}");
check("scopes + codeSyntax in $extensions (figma.com)", dtcg.color.primary.$extensions["figma.com"].scopes[0] === "FRAME_FILL" && dtcg.color.primary.$extensions["figma.com"].codeSyntax.WEB === "var(--color-primary)");
// DTCG 2025.10: a length is $type "dimension" with the OBJECT value {value, unit:"px"|"rem"}; a bare
// number under "dimension" (or a length typed as "number") is what Style Dictionary emits unitless.
check("length FLOAT -> dimension {value, unit:'px'} (DTCG 2025.10 object form)", dtcg.space.md.$type === "dimension" && dtcg.space.md.$value.value === 16 && dtcg.space.md.$value.unit === "px");
check("unitless FLOAT (OPACITY scope) stays $type number + literal", (() => { const d = toDTCG({ variables: [{ name: "opacity/disabled", type: "FLOAT", scopes: ["OPACITY"], values: { v: 0.5 } }] }); return d.opacity.disabled.$type === "number" && d.opacity.disabled.$value === 0.5; })());
check("dimension: aliases stay references, per-mode values get the object form too", (() => {
  const d = toDTCG({ collections: [{ name: "S", modes: ["Compact", "Cozy"], default: "Compact" }], variables: [
    { name: "space/base", type: "FLOAT", collection: "S", values: { Compact: 8, Cozy: 12 } },
    { name: "space/gap", type: "FLOAT", collection: "S", values: { Compact: { aliasOf: "space/base" }, Cozy: { aliasOf: "space/base" } } }] });
  const m = d.space.base.$extensions["figma.com"].modes;
  return d.space.gap.$type === "dimension" && d.space.gap.$value === "{space.base}" && m.Cozy.value === 12 && m.Cozy.unit === "px";
})());
check("DTCG and CSS agree on which FLOATs are lengths (one unitDecision, opts.unitless honoured)", (() => {
  const one = { variables: [{ name: "z/modal", type: "FLOAT", values: { v: 100 } }] }, opts = { unitless: new Set(["z/modal"]) };
  const e = emitTokens(one, opts);
  return e.dtcg.z.modal.$type === "number" && e.dtcg.z.modal.$value === 100 && e.css.includes("--z-modal: 100;");
})());
check("description -> $description", dtcg.color.primary.$description === "Primary brand");
check("clean ds lints clean", lintTokens(ds).length === 0);
// DTCG 2025.10 conformance: no typeless leaves; 6-digit hex fallback; boolean coerced not dropped.
check("[T-str-type] STRING -> $type:'string' (valid, not typeless)", (() => { const d = toDTCG({ variables: [{ name: "font/sans", type: "STRING", values: { v: "Inter" } }] }); return d.font.sans.$type === "string" && d.font.sans.$value === "Inter"; })());
check("[T-bool-coerce] BOOLEAN -> $type:'string' + origin in $extensions (no typeless leaf)", (() => { const w = []; const d = toDTCG({ variables: [{ name: "flag/on", type: "BOOLEAN", values: { v: true } }] }, w); return d.flag.on.$type === "string" && d.flag.on.$value === "true" && d.flag.on.$extensions["figma.com"].originalType === "boolean" && w.some((m) => /BOOLEAN/.test(m)); })());
check("[T-6hex] color leaf hex fallback always 6-digit, alpha split out (2025.10)", (() => { const d = toDTCG({ variables: [{ name: "scrim", type: "COLOR", values: { v: "#00000080" } }] }); return d.scrim.$value.hex === "#000000" && near(d.scrim.$value.alpha, 0.502); })());

// ---------- tokens: color hardening ----------
console.log("tokens — color:");
check("[H2] shorthand #fff -> full color object", (() => { const v = hexToColorValue("#fff"); return v.hex === "#ffffff" && near(v.components[0], 1) && near(v.components[2], 1); })());
check("[H4] alpha in `alpha` field, hex fallback stays 6-digit (DTCG 2025.10)", (() => { const v = hexToColorValue("#00000080"); return v.hex === "#000000" && near(v.alpha, 0.502); })());
check("malformed hex -> null (caller can guard)", hexToColorValue("#12345") === null);
check("P3 profile -> display-p3", hexToColorValue("#2563eb", "display-p3").colorSpace === "display-p3");

// ---------- tokens: CSS ----------
console.log("tokens — CSS:");
const css = toCSS(ds);
check("semantic -> var chain", css.includes("--color-primary: var(--blue-600);"));
check("[B4] primitive hex emitted EXACTLY once", (css.match(/--blue-600: #2563eb;/g) || []).length === 1);
check("[H5] FLOAT emitted with px unit", css.includes("--space-md: 16px;"));
check("[H6] cssVarName preserves case (custom props are case-sensitive)", cssVarName("color/Text Primary") === "--color-Text-Primary");
const darkBlock = (css.match(/\[data-theme="Dark"\]\s*\{([^}]*)\}/) || [])[1] || "";
check("dark block overrides differing token", darkBlock.includes("--color-primary: var(--blue-300);"));
check("[M1] per-mode dedup: equal-to-default token has NO override", !darkBlock.includes("color-muted"));

// ---------- tokens: DTCG Resolver Module 2025.10 ----------
// Spec: designtokens.org/tr/2025.10/resolver/ — `version` (MUST be "2025.10") and `resolutionOrder`
// are the only REQUIRED root keys; a set MUST have `sources`; a modifier MUST have a non-empty
// `contexts` map and its `default` MUST be one of its context keys.
console.log("tokens — resolver:");
const rw = [];
const { resolver: rz, files: rzFiles } = toResolver(ds, rw);
check("[R1] required root shape: version '2025.10' + resolutionOrder array", rz.version === "2025.10" && Array.isArray(rz.resolutionOrder) && rz.$schema === "https://www.designtokens.org/schemas/2025.10/resolver.json");
check("[R2] every set has a `sources` array of reference objects that name an emitted file", Object.keys(rz.sets).length === 2 && Object.values(rz.sets).every((s) => Array.isArray(s.sources) && s.sources.every((src) => typeof src.$ref === "string" && rzFiles[src.$ref])));
check("[R3] multi-mode collection -> modifier with both contexts + spec-valid default", (() => {
  const m = rz.modifiers.Semantic;
  return m && Object.keys(m.contexts).sort().join(",") === "Dark,Light" && m.default === "Light" && Object.keys(m.contexts).includes(m.default);
})());
check("[R4] single-mode collection contributes a set but NO modifier", rz.sets.Primitives && rz.modifiers.Primitives === undefined);
check("[R5] default-mode context is the empty array (nothing differs), no file written", Array.isArray(rz.modifiers.Semantic.contexts.Light) && rz.modifiers.Semantic.contexts.Light.length === 0);
const darkSet = rzFiles[rz.modifiers.Semantic.contexts.Dark[0].$ref];
check("[R6] context set holds ONLY the differing token (same dedup as toCSS)", darkSet.color.primary !== undefined && darkSet.color.muted === undefined);
check("[R7] aliases preserved as {a.b} references in set files (resolved only at resolution time)", darkSet.color.primary.$value === "{blue.300}" && rzFiles[rz.sets.Semantic.sources[0].$ref].color.primary.$value === "{blue.600}");
check("[R8] dimensions keep the 2025.10 object form inside set files", (() => { const base = rzFiles[rz.sets.Primitives.sources[0].$ref]; return base.space.md.$type === "dimension" && base.space.md.$value.value === 16 && base.space.md.$value.unit === "px"; })());
check("[R9] set files carry no $extensions.modes (the resolver IS the mode mechanism)", rzFiles[rz.sets.Semantic.sources[0].$ref].color.primary.$extensions === undefined);
check("[R10] resolutionOrder refs resolve in-document, sets before modifiers", (() => {
  const ptrs = rz.resolutionOrder.map((r) => r.$ref);
  const idx = ptrs.findIndex((p) => p.startsWith("#/modifiers/"));
  const resolve = (p) => p.split("/").slice(1).reduce((o, k) => o && o[k.replace(/~1/g, "/").replace(/~0/g, "~")], rz);
  return ptrs.length === 3 && ptrs.every((p) => resolve(p) !== undefined) && idx === 2;
})());
check("[R11] emitTokens/CLI surface: resolver + files alongside the UNCHANGED dtcg/css outputs", (() => {
  const e = emitTokens(ds);
  return e.resolver.version === "2025.10" && Object.keys(e.resolverFiles).every((k) => k.startsWith("tokens/") && k.endsWith(".json"))
    && JSON.stringify(e.dtcg) === JSON.stringify(toDTCG(ds)) && e.dtcg.color.primary.$extensions["figma.com"].modes.Dark === "{blue.300}";
})());
check("[R12] single-mode-only design system -> valid resolver with NO modifiers key", (() => {
  const r = toResolver({ collections: [{ name: "P", modes: ["Value"], default: "Value" }], variables: [{ name: "a/b", type: "COLOR", collection: "P", values: { Value: "#000000" } }] }).resolver;
  return r.modifiers === undefined && r.version === "2025.10" && r.resolutionOrder.length === 1;
})());
check("[R13] filename collision after sanitizing -> warned + disambiguated, never overwritten", (() => {
  const w = [];
  const r = toResolver({ collections: [{ name: "C", modes: ["Light", "light", "LIGHT"], default: "Light" }], variables: [
    { name: "bg", type: "COLOR", collection: "C", values: { Light: "#111111", light: "#222222", LIGHT: "#333333" } }] }, w);
  const refs = ["light", "LIGHT"].map((m) => r.resolver.modifiers.C.contexts[m][0].$ref);
  return refs[0] !== refs[1] && new Set(refs).size === 2 && Object.keys(r.files).length === 3
    && r.files[refs[0]].bg.$value.hex === "#222222" && r.files[refs[1]].bg.$value.hex === "#333333"
    && w.some((m) => /collides/.test(m));
})());
check("[R14] `__proto__` mode name neither pollutes nor vanishes", (() => {
  const ds2 = JSON.parse('{"collections":[{"name":"C","modes":["Light","__proto__"],"default":"Light"}],"variables":[{"name":"bg","type":"COLOR","collection":"C","values":{"Light":"#111111","__proto__":"#222222"}}]}');
  const r = toResolver(ds2);
  const ctx = r.resolver.modifiers.C.contexts;
  const ref = Object.prototype.hasOwnProperty.call(ctx, "__proto__") && ctx["__proto__"][0].$ref;
  return !!ref && r.files[ref].bg.$value.hex === "#222222" && ({}).bg === undefined
    && JSON.parse(JSON.stringify(r.resolver)).modifiers.C.contexts["__proto__"] !== undefined;
})());
check("[R15] round-trip: base + context in resolutionOrder reproduces $extensions.modes exactly", (() => {
  const d = toDTCG(ds);
  const flat = (tree, prefix, out) => { for (const k of Object.keys(tree)) { const n = tree[k]; const p = prefix ? prefix + "." + k : k; if (n && n.$value !== undefined) out[p] = n.$value; else if (n && typeof n === "object") flat(n, p, out); } return out; };
  const modes = ["Light", "Dark"];
  return modes.every((mode) => {
    const merged = {};
    for (const item of rz.resolutionOrder) { // spec ordering: later entries override earlier ones
      if (item.$ref.startsWith("#/sets/")) { const s = rz.sets[item.$ref.slice(7)]; for (const src of s.sources) Object.assign(merged, flat(rzFiles[src.$ref], "", {})); }
      else { const m = rz.modifiers[item.$ref.slice(12)]; const ctx = m.contexts[mode] || m.contexts[m.default]; for (const src of ctx) Object.assign(merged, flat(rzFiles[src.$ref], "", {})); }
    }
    const expected = flat(d, "", {});
    for (const p of Object.keys(expected)) {
      const leaf = p.split(".").reduce((o, k) => o[k], d);
      const ext = leaf.$extensions && leaf.$extensions["figma.com"];
      const want = ext && ext.modes && ext.modes[mode] !== undefined ? ext.modes[mode] : expected[p];
      if (JSON.stringify(merged[p]) !== JSON.stringify(want)) return false;
    }
    return Object.keys(merged).length === Object.keys(expected).length;
  });
})());
check("[R16] resolver emits no NEW warnings on a clean design system", rw.length === 0 && lintTokens(ds).length === 0);

// ---------- tokens: never-silent lint (H1/H3/H7/H8) ----------
console.log("tokens — lint:");
check("[H1] group/leaf collision reported (no silent loss)", lintTokens({ variables: [{ name: "color", type: "COLOR", values: { v: "#111111" } }, { name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }] }).some((w) => /collide/.test(w)));
check("[H1] collision does not produce an illegal both-$value-and-child node", (() => { const d = toDTCG({ variables: [{ name: "color", type: "COLOR", values: { v: "#111111" } }, { name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }] }); return !(d.color && d.color.$value !== undefined && d.color.primary); })());
check("[H3] no-value-in-any-mode reported + skipped", (() => { const w = []; const d = toDTCG({ variables: [{ name: "x", type: "COLOR", values: {} }] }, w); return w.some((m) => /no value/.test(m)) && d.x === undefined; })());
check("[H3] toCSS never emits `undefined`", !toCSS({ collections: [{ name: "C", modes: ["Light", "Dark"], default: "Light" }], variables: [{ name: "bg", type: "COLOR", collection: "C", values: { Dark: "#000000" } }] }).includes("undefined"));
check("[H7] dangling alias reported", lintTokens({ variables: [{ name: "a", type: "COLOR", values: { v: { aliasOf: "does/not/exist" } } }] }).some((w) => /undefined token/.test(w)));
check("[H8] empty-name skipped in CSS (no `--:`)", !toCSS({ variables: [{ name: "", type: "COLOR", values: { v: "#abcdef" } }] }).includes("--:"));
check("[H6b] var-name collision from distinct names reported", lintTokens({ variables: [{ name: "spacing/4", type: "FLOAT", values: { v: 16 } }, { name: "spacing-4", type: "FLOAT", values: { v: 99 } }] }).some((w) => /fold onto one identifier and resolve DIFFERENTLY/.test(w)));
check("[H6b] and BOTH are emitted — nothing overwritten", (() => {
  const css = toCSS({ variables: [{ name: "spacing/4", type: "FLOAT", values: { v: 16 } }, { name: "spacing-4", type: "FLOAT", values: { v: 99 } }] });
  return /: 16px;/.test(css) && /: 99px;/.test(css);
})());

// ---------- map validation (B2: additionalProperties + per-kind oneOf) ----------
console.log("map — validation:");
const ok = (m) => validateMap(m).ok;
const okEntry = { figma: { name: "B" }, code: { module: "m", export: "E" } };
check("valid minimal passes", ok({ version: 1, components: { K: okEntry } }));
check("missing code.export fails", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m" } } } }));
check("bad prop kind fails", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "weird", codeProp: "p" } } } } }));
check("[B2] unknown key on entry rejected (additionalProperties)", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, bogus: 1 } } }));
check("[B2] typo'd figma key rejected", !ok({ version: 1, components: { K: { figma: { name: "B", naem: "x" }, code: { module: "m", export: "E" } } } }));
check("[B2] extra top-level key rejected", !ok({ version: 1, components: {}, junk: 1 }));
check("[B2] enum prop carrying `slot` rejected (per-kind oneOf)", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "enum", codeProp: "p", slot: "x" } } } } }));
check("[B2] string prop carrying `values` rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "string", codeProp: "p", values: { a: "b" } } } } } }));
check("[B2] instance `slot` as number rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "instance", slot: 5 } } } } }));
check("[B2] enum default as object rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "enum", codeProp: "p", default: { x: 1 } } } } } }));
check("[B2] boolean default as string rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "boolean", codeProp: "p", default: "yes" } } } } }));
check("[B2] variantOverrides.when non-string value rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, variantOverrides: [{ when: { size: 5 }, code: { module: "m", export: "E" } }] } } }));
check("[B2] childrenByLayer junk key rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, childrenByLayer: { layerNamePattern: "*", nope: 1 } } } }));
check("valid full entry (targets/variantOverrides/childrenByLayer/instance) passes", ok({ version: 1, components: { K: { figma: { name: "B", key: "k" }, code: { module: "m", export: "E", targets: { web: { module: "w", export: "W" } } }, props: { I: { kind: "instance", slot: "icon" } }, variantOverrides: [{ when: { Type: "Danger" }, code: { module: "d", export: "D" } }], childrenByLayer: { slot: "children" } } } }));
check("null map fails gracefully", validateMap(null).ok === false);

// ---------- drift lint (F1..F8) ----------
console.log("drift — lint:");
const single = (props) => ({ components: [{ key: "K", name: "Btn", type: "COMPONENT", props: props || {} }] });
// [F1] deleted mapped component is ORPHANED, not silently rebound by name.
const f1 = driftLint({ version: 1, components: { K_DELETED: { figma: { key: "K_DELETED", name: "Button", id: "9:9" } } } }, { components: [{ key: "K_LIVE", id: "1:1", name: "Button", type: "COMPONENT" }] });
check("[F1] deleted key -> orphaned error (not name-rebind)", f1.errors.some((e) => e.code === "orphaned-entry" && e.suggestedKey === "K_LIVE"));
// [F3] unpublished component keyed by node id matches.
check("[F3] unpublished component keyed by id matches (no false error)", driftLint({ version: 1, components: { "3:3": { figma: { name: "Card", id: "3:3" }, code: { module: "m", export: "E" } } } }, { components: [{ id: "3:3", name: "Card", type: "COMPONENT" }] }).errors.length === 0);
// [F5] figma.key wins over an incidental map-key collision.
const f5 = driftLint({ version: 1, components: { Primary: { figma: { key: "REAL", name: "Primary" } } } }, { components: [{ key: "Primary", id: "1:1", name: "Danger", type: "COMPONENT" }, { key: "REAL", id: "2:2", name: "Primary", type: "COMPONENT" }] });
check("[F5] figma.key outranks map-key collision (no fabricated rename)", !f5.errors.length && !f5.warnings.some((w) => w.code === "stale-name") && f5.warnings.some((w) => w.code === "unmapped-component" && w.name === "Danger"));
// [F6] #uid prop suffix normalized on both sides.
check("[F6] #uid prop suffix does not cause false stale-prop", driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { "Size#12:3": { kind: "enum", codeProp: "size", values: { sm: "s", lg: "l" } } } } } }, single({ "Size": { type: "VARIANT", options: ["sm", "lg"] } })).errors.length === 0);
// [F7] VARIANT with no options -> warn, not false error.
const f7 = driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { Size: { kind: "enum", codeProp: "s", values: { bogus: "x" } } } } } }, single({ Size: { type: "VARIANT" } }));
check("[F7] VARIANT missing options -> warning, no false error", f7.warnings.some((w) => w.code === "no-variant-options") && !f7.errors.length);
// [F8] double-map detected.
check("[F8] two entries -> one component reported", driftLint({ version: 1, components: { K: { figma: { key: "K" } }, K2: { figma: { key: "K" } } } }, single()).errors.some((e) => e.code === "double-mapped"));
// [F4] duplicate catalog key -> warn, shadowed twin NOT falsely unmapped.
const f4 = driftLint({ version: 1, components: { K: { figma: { key: "K" } } } }, { components: [{ key: "K", id: "1:1", name: "A", type: "COMPONENT" }, { key: "K", id: "2:2", name: "B", type: "COMPONENT" }] });
check("[F4] duplicate catalog key warned, no spurious unmapped", f4.warnings.some((w) => w.code === "duplicate-key") && !f4.warnings.some((w) => w.code === "unmapped-component"));
// [M5] unknown variant value -> error.
check("[M5] mapping a non-existent variant option -> error", driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { Size: { kind: "enum", codeProp: "s", values: { nope: "x" } } } } } }, single({ Size: { type: "VARIANT", options: ["sm"] } })).errors.some((e) => e.code === "unknown-variant-value"));
// still-caught basics + a genuinely clean map is warning-clean too.
check("kind mismatch caught", driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { Size: { kind: "boolean", codeProp: "s" } } } } }, single({ Size: { type: "VARIANT", options: ["a"] } })).errors.some((e) => e.code === "kind-mismatch"));
check("stale prop caught", driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { Ghost: { kind: "boolean", codeProp: "g" } } } } }, single()).errors.some((e) => e.code === "stale-prop"));
const clean = driftLint({ version: 1, components: {
  KEY_BTN: { figma: { key: "KEY_BTN", name: "Button" }, code: { module: "m", export: "E" }, props: { Variant: { kind: "enum", codeProp: "v", values: { Primary: "primary", Secondary: "secondary" } }, Disabled: { kind: "boolean", codeProp: "d" }, Label: { kind: "string", codeProp: "children" }, Icon: { kind: "instance", slot: "icon" } } },
  KEY_CARD: { figma: { key: "KEY_CARD", name: "Card" }, code: { module: "m", export: "C" } },
} }, ds);
check("[B4] complete map is error- AND warning-clean", clean.errors.length === 0 && clean.warnings.length === 0);

console.log("drift — staleness:");
const { checkFreshness, DEFAULT_MAX_AGE_MS } = require("../design-to-code/drift-lint");
const emptyMap = { version: 1, components: {} };
check("[stale-1] missing exportedAt -> unknown-freshness warning", driftLint(emptyMap, { components: [] }).warnings.some((w) => w.code === "unknown-freshness"));
check("[stale-2] unparseable exportedAt -> unknown-freshness warning", driftLint(emptyMap, { exportedAt: "not-a-date", components: [] }).warnings.some((w) => w.code === "unknown-freshness"));
check("[stale-3] fresh export (1h old, default 24h max) -> no staleness warning at all", driftLint(emptyMap, { exportedAt: new Date(Date.now() - 3600000).toISOString(), components: [] }).warnings.every((w) => w.code !== "stale-snapshot" && w.code !== "unknown-freshness"));
check("[stale-4] export older than default 24h max-age -> stale-snapshot warning", driftLint(emptyMap, { exportedAt: new Date(Date.now() - 30 * 3600000).toISOString(), components: [] }).warnings.some((w) => w.code === "stale-snapshot"));
check("[stale-5] stale-snapshot message names the file and is unmistakably prominent", (() => {
  const w = driftLint(emptyMap, { exportedAt: new Date(Date.now() - 30 * 3600000).toISOString(), file: "My File", components: [] }).warnings.find((w) => w.code === "stale-snapshot");
  return w && /^STALE SNAPSHOT/.test(w.message) && w.message.includes("My File");
})());
check("[stale-6] never silently passes: EVERY driftLint result carries a freshness verdict (warning or explicit pass)", (() => {
  const fresh = driftLint(emptyMap, { exportedAt: new Date().toISOString(), components: [] });
  return fresh.freshness === undefined && fresh.warnings.every((w) => w.code !== "stale-snapshot" && w.code !== "unknown-freshness");
})());
check("[stale-7] --max-age override via opts.maxAgeMs: a 30h-old export is fine at 48h max", driftLint(emptyMap, { exportedAt: new Date(Date.now() - 30 * 3600000).toISOString(), components: [] }, { maxAgeMs: 48 * 3600000 }).warnings.every((w) => w.code !== "stale-snapshot"));
check("[stale-8] --max-age override makes a normally-fresh export stale at a tight threshold", driftLint(emptyMap, { exportedAt: new Date(Date.now() - 3600000).toISOString(), components: [] }, { maxAgeMs: 1800000 }).warnings.some((w) => w.code === "stale-snapshot"));
check("[stale-9] checkFreshness default max-age constant is 24h", DEFAULT_MAX_AGE_MS === 24 * 3600000);
check("[stale-10] checkFreshness's returned warning matches what it pushed into the array", (() => {
  const warnings = [];
  const push = (arr, code, message, extra) => arr.push(Object.assign({ code, message }, extra || {}));
  const w = checkFreshness({ exportedAt: new Date(Date.now() - 30 * 3600000).toISOString() }, push, warnings, {});
  return w && w.code === "stale-snapshot" && warnings.length === 1 && warnings[0].code === w.code && warnings[0].message === w.message;
})());

// ---------- bootstrap (A1..A7, M3, M4) ----------
console.log("bootstrap:");
const boot = bootstrap(ds);
check("component keyed by publish key + needs-review", !!boot.components.KEY_BTN && boot.components.KEY_BTN.status === "needs-review");
check("[M4] export PascalCased from multi-word name", bootstrap({ components: [{ key: "K", name: "Icon Button", type: "COMPONENT" }] }).components.K.code.export === "IconButton");
check("[A7] slash-namespaced name keeps namespace in export", bootstrap({ components: [{ key: "K", name: "Button/Primary/Danger", type: "COMPONENT" }] }).components.K.code.export === "ButtonPrimaryDanger");
check("VARIANT -> enum identity + default/omitDefault", boot.components.KEY_BTN.props.Variant.kind === "enum" && boot.components.KEY_BTN.props.Variant.values.Primary === "Primary" && boot.components.KEY_BTN.props.Variant.default === "Primary" && boot.components.KEY_BTN.props.Variant.omitDefault === true);
check("[M3] BOOLEAN -> boolean prop with default+omitDefault", boot.components.KEY_BTN.props.Disabled.kind === "boolean" && boot.components.KEY_BTN.props.Disabled.codeProp === "disabled" && boot.components.KEY_BTN.props.Disabled.default === false && boot.components.KEY_BTN.props.Disabled.omitDefault === true);
check("TEXT named Label -> children", boot.components.KEY_BTN.props.Label.codeProp === "children");
check("INSTANCE_SWAP -> instance slot", boot.components.KEY_BTN.props.Icon.kind === "instance" && boot.components.KEY_BTN.props.Icon.slot === "icon");
check("bootstrap output passes validation", validateMap(boot).ok);
// [A3] catalog component with no name -> still valid output.
const a3 = bootstrap({ components: [{ key: "K1", type: "COMPONENT" }] });
check("[A3] missing component name -> figma.name is a string, output valid", typeof a3.components.K1.figma.name === "string" && validateMap(a3).ok);
// [A1] confirmed entry whose component is absent from catalog is PRESERVED, not dropped.
check("[A1] confirmed entry absent from catalog is preserved", "GONE" in bootstrap(ds, { version: 1, components: { GONE: { figma: { key: "GONE", name: "Gone" }, code: { module: "@/hand", export: "Hand" }, status: "active" } } }).components);
// [A2] re-run does NOT clobber in-progress needs-review edits; DOES add new props.
const a2existing = { version: 1, components: { KEY_BTN: { figma: { key: "KEY_BTN", name: "Button" }, code: { module: "@/half/Done", export: "MyButton" }, status: "needs-review", props: { Variant: { kind: "enum", codeProp: "kind", values: { Primary: "solid" } } } } } };
const a2 = bootstrap(ds, a2existing);
check("[A2] needs-review human edits preserved (module/export/prop)", a2.components.KEY_BTN.code.module === "@/half/Done" && a2.components.KEY_BTN.code.export === "MyButton" && a2.components.KEY_BTN.props.Variant.codeProp === "kind" && a2.components.KEY_BTN.props.Variant.values.Primary === "solid");
check("[A2] re-run adds newly-appeared props", !!a2.components.KEY_BTN.props.Disabled && !!a2.components.KEY_BTN.props.Icon);
// [A5] existing argument not mutated.
const a5existing = { version: 1, components: { KEEP: { figma: { key: "KEEP", name: "Old" }, code: { module: "@/x", export: "X" }, status: "active" } } };
const a5 = bootstrap({ components: [{ key: "KEEP", name: "New", id: "9:9", type: "COMPONENT" }] }, a5existing);
check("[A5] existing arg not mutated; output refreshes metadata + keeps code", a5existing.components.KEEP.figma.name === "Old" && a5.components.KEEP.figma.name === "New" && a5.components.KEEP.code.export === "X");

// ================= SECOND-ROUND: regressions from the fix pass + closed test gaps =================
console.log("tokens — 2nd round:");
check("[R1] OPACITY-scoped FLOAT emits unitless CSS (no px)", toCSS({ variables: [{ name: "opacity/disabled", type: "FLOAT", scopes: ["OPACITY"], values: { v: 0.5 } }] }).includes("--opacity-disabled: 0.5;"));
check("[R1] dimension FLOAT still gets px", toCSS({ variables: [{ name: "gap/lg", type: "FLOAT", values: { v: 24 } }] }).includes("--gap-lg: 24px;"));
check("[R1b] zero FLOAT stays unitless 0", toCSS({ variables: [{ name: "gap/none", type: "FLOAT", values: { v: 0 } }] }).includes("--gap-none: 0;"));
check("[R2] undefined-default value -> dedup vs emitted base (no duplicate override)", (toCSS({ collections: [{ name: "C", modes: ["Light", "Dark"], default: "Light" }], variables: [{ name: "bg", type: "COLOR", collection: "C", values: { Light: undefined, Dark: "#000000" } }] }).match(/#000000/g) || []).length === 1);
check("[H1-rev] reverse-order group/leaf collision reported", lintTokens({ variables: [{ name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }, { name: "color", type: "COLOR", values: { v: "#111111" } }] }).some((w) => /collide/.test(w)));
check("[H1-rev] reverse-order produces no illegal both-$value-and-child node", (() => { const d = toDTCG({ variables: [{ name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }, { name: "color", type: "COLOR", values: { v: "#111111" } }] }); return !(d.color && d.color.$value !== undefined && d.color.primary); })());
check("[H2b] malformed hex on COLOR reported by toDTCG", (() => { const w = []; toDTCG({ variables: [{ name: "brand", type: "COLOR", values: { v: "#12345" } }] }, w); return w.some((m) => /malformed hex/.test(m)); })());

console.log("drift — 2nd round:");
const reg3 = driftLint({ version: 1, components: { SHARED: { figma: { id: "2:2", name: "Right" } } } }, { components: [{ key: "SHARED", id: "1:1", name: "Wrong", type: "COMPONENT" }, { key: "K2", id: "2:2", name: "Right", type: "COMPONENT" }] });
check("[REG-3] explicit figma.id outranks map-key collision", !reg3.errors.length && !reg3.warnings.some((w) => w.code === "stale-name") && reg3.warnings.some((w) => w.code === "unmapped-component" && w.name === "Wrong"));
check("[REG-1] ambiguous base-name prop surfaced (not silently shadowed)", driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { "Size#1": { kind: "enum", codeProp: "s", values: {} }, "Size#2": { kind: "enum", codeProp: "s2", values: {} } } } } }, single()).warnings.some((w) => w.code === "ambiguous-prop"));
// [F2-stale] an explicitly declared figma.key that no longer resolves is ORPHANED even when the map key
// coincidentally matches a DIFFERENT live component — no silent rebind (the whole point of the tool).
const f2 = driftLint({ version: 1, components: { LIVE: { figma: { key: "DEAD", name: "Old" }, code: { module: "m", export: "E" } } } }, { components: [{ key: "LIVE", id: "1:1", name: "Other", type: "COMPONENT" }] });
check("[F2-stale] stale figma.key -> orphaned despite map-key collision (no rebind)", f2.errors.some((e) => e.code === "orphaned-entry" && e.mapKey === "LIVE") && f2.warnings.some((w) => w.code === "unmapped-component" && w.name === "Other") && !f2.warnings.some((w) => w.code === "stale-name"));
check("stale-name FIRES on rename (positive)", driftLint({ version: 1, components: { K: { figma: { key: "K", name: "Old" } } } }, { components: [{ key: "K", name: "New", type: "COMPONENT" }] }).warnings.some((w) => w.code === "stale-name"));
check("uncovered-prop FIRES (positive)", driftLint({ version: 1, components: { K: { figma: { key: "K" } } } }, single({ V: { type: "VARIANT", options: ["a"] } })).warnings.some((w) => w.code === "uncovered-prop"));
check("unmapped-variant-value FIRES (positive)", driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { V: { kind: "enum", codeProp: "v", values: { a: "A" } } } } } }, single({ V: { type: "VARIANT", options: ["a", "b"] } })).warnings.some((w) => w.code === "unmapped-variant-value"));

console.log("bootstrap — 2nd round:");
const a1ex = { version: 1, components: { GONE: { figma: { key: "GONE", name: "Gone" }, code: { module: "@/hand", export: "Hand" }, status: "active", props: { X: { kind: "boolean", codeProp: "x" } } } } };
const a1out = bootstrap({ components: [] }, a1ex);
check("[A1] orphan preserved with FULL content (deep-equal) + valid", JSON.stringify(a1out.components.GONE) === JSON.stringify(a1ex.components.GONE) && validateMap(a1out).ok);
const r4out = bootstrap({ components: [{ key: "K", id: "1:1", name: "Btn", type: "COMPONENT" }] }, { version: 1, components: { "1:1": { figma: { id: "1:1", name: "Btn" }, code: { module: "@/kept", export: "Btn" }, status: "active" } } });
check("[R4] component gaining a key does NOT duplicate + keeps human code", Object.keys(r4out.components).length === 1 && !!r4out.components.K && !r4out.components["1:1"] && r4out.components.K.code.module === "@/kept");
check("[R1t] prop whose Figma type changed is regenerated", bootstrap({ components: [{ key: "K", name: "B", type: "COMPONENT", props: { Size: { type: "BOOLEAN", default: false } } }] }, { version: 1, components: { K: { figma: { key: "K", name: "B" }, code: { module: "@/k", export: "B" }, status: "active", props: { Size: { kind: "enum", codeProp: "size", values: { a: "A" } } } } } }).components.K.props.Size.kind === "boolean");
check("[NEW3] stub with human export+prop edits preserved even under TODO module (no wholesale regen)", (() => { const n = bootstrap({ components: [{ key: "K", name: "Right", type: "COMPONENT", props: { V: { type: "VARIANT", options: ["Primary", "Secondary"] } } }] }, { version: 1, components: { K: { figma: { key: "K", name: "Wrong" }, code: { module: "TODO: import path", export: "MyName" }, status: "needs-review", props: { V: { kind: "enum", codeProp: "kind", values: { Primary: "solid" } } } } } }); return n.components.K.code.export === "MyName" && n.components.K.props.V.codeProp === "kind" && n.components.K.props.V.values.Primary === "solid"; })());
check("[A2t] added prop has correct kind+codeProp (not just presence)", a2.components.KEY_BTN.props.Disabled.kind === "boolean" && a2.components.KEY_BTN.props.Disabled.codeProp === "disabled");
check("[M1t] non-label TEXT -> camelCase codeProp (not children)", bootstrap({ components: [{ key: "K", name: "B", type: "COMPONENT", props: { Placeholder: { type: "TEXT" } } }] }).components.K.props.Placeholder.codeProp === "placeholder");

console.log("validator — 2nd round (negative coverage):");
check("[V] version 2 rejected", !ok({ version: 2, components: {} }));
check("[V] code.targets numeric module rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E", targets: { web: { module: 5 } } } } } }));
check("[V] variantOverrides.code missing export rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, variantOverrides: [{ when: { T: "x" }, code: { module: "m" } }] } } }));
check("[V] figma.unstable non-bool rejected", !ok({ version: 1, components: { K: { figma: { name: "B", unstable: "yes" }, code: { module: "m", export: "E" } } } }));
check("[V] boolean omitDefault non-bool rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "boolean", codeProp: "p", omitDefault: "no" } } } } }));
check("[V] figmaFileKey non-string rejected", !ok({ version: 1, components: {}, figmaFileKey: 5 }));

// ================= THIRD-ROUND: close proven mutation survivors from the re-review of the fixes =====
console.log("tokens — 3rd round:");
check("[T-fw] FONT_WEIGHT-scoped FLOAT is unitless", toCSS({ variables: [{ name: "weight/bold", type: "FLOAT", scopes: ["FONT_WEIGHT"], values: { v: 700 } }] }).includes("--weight-bold: 700;"));
check("[T-ul] opts.unitless overrides px", toCSS({ variables: [{ name: "z/top", type: "FLOAT", values: { v: 100 } }] }, { unitless: new Set(["z/top"]) }).includes("--z-top: 100;"));
check("[T-sn] string-number FLOAT gets px", toCSS({ variables: [{ name: "s/x", type: "FLOAT", values: { v: "16" } }] }).includes("--s-x: 16px;"));
// [T-lh] Figma LineHeight is px|percent, NEVER a unitless multiplier -> px is the correct default
// (unitless `line-height: 24` would mean 24x font size). See UNITLESS_SCOPES comment.
check("[T-lh] LINE_HEIGHT-scoped FLOAT stays px (not unitless)", toCSS({ variables: [{ name: "text/lh", type: "FLOAT", scopes: ["LINE_HEIGHT"], values: { v: 24 } }] }).includes("--text-lh: 24px;"));
// [T-ls] letter-spacing bare number is invalid CSS -> px, not unitless.
check("[T-ls] LETTER_SPACING-scoped FLOAT stays px (bare number is invalid CSS)", toCSS({ variables: [{ name: "text/ls", type: "FLOAT", scopes: ["LETTER_SPACING"], values: { v: 0.5 } }] }).includes("--text-ls: 0.5px;"));
// ---------- [RD-*] real-data regressions: names/scopes taken from a live "Design System - NERA"
// file (Figma starter plan). The mock fixtures above all set NARROW scopes, which hid these: real
// files leave Figma's default ALL_SCOPES in place, so the scopes-only unit rule emitted invalid CSS.
check("[RD-fw] ALL_SCOPES font-weight is unitless by NAME (was `500px`, invalid CSS)",
  toCSS({ variables: [{ name: "Font-Weight/medium", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 500 } }] }).includes("--Font-Weight-medium: 500;"));
check("[RD-op] ALL_SCOPES opacity is unitless by NAME (was `0.5px`, invalid CSS)",
  toCSS({ variables: [{ name: "Opacity/disabled", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 0.5 } }] }).includes("--Opacity-disabled: 0.5;"));
check("[RD-nos] the same holds when `scopes` is absent entirely",
  toCSS({ variables: [{ name: "font-weight/bold", type: "FLOAT", values: { v: 700 } }] }).includes("--font-weight-bold: 700;"));
// A font SIZE is a genuine length -> must keep px. Guards the name heuristic against over-reach.
check("[RD-fs] font-SIZE keeps px (heuristic does not over-match `font`)",
  toCSS({ variables: [{ name: "Font-Size/Text-sm", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 14 } }] }).includes("--Font-Size-Text-sm: 14px;"));
// A NARROWED scope stays authoritative — the name must never override an explicit designer signal.
check("[RD-narrow] explicit LINE_HEIGHT scope beats a name containing 'weight'",
  toCSS({ variables: [{ name: "weight/line-height", type: "FLOAT", scopes: ["LINE_HEIGHT"], values: { v: 24 } }] }).includes("--weight-line-height: 24px;"));
// The name heuristic is a GUESS, and every other rewrite in this file announces itself. A silent one
// is only visible as surprising CSS downstream.
check("[RD-say] a unit decided by NAME rather than scopes is reported by lintTokens",
  lintTokens({ variables: [{ name: "Opacity/disabled", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 0.5 } }] })
    .some((w) => /Opacity\/disabled/.test(w) && /UNITLESS/.test(w)));
check("[RD-say] but a token the SCOPES decided is not reported (no noise on an explicit signal)",
  !lintTokens({ variables: [{ name: "opacity/disabled", type: "FLOAT", scopes: ["OPACITY"], values: { v: 0.5 } }] })
    .some((w) => /UNITLESS/.test(w)));
// numberUnit short-circuits on opts.unitless BEFORE the name heuristic, so a token the caller named
// explicitly never reaches the guess. lintTokens has to take the same opts or it warns about a guess
// that was never made — and tells the caller to go fix it in Figma when they already fixed it here.
const nameGuessDs = { variables: [{ name: "Opacity/disabled", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 0.5 } }] };
const overrideOpts = { unitless: new Set(["Opacity/disabled"]) };
check("[RD-opts] a token overridden via opts.unitless is NOT reported as a name guess",
  !lintTokens(nameGuessDs, overrideOpts).some((w) => /UNITLESS/.test(w)));
check("[RD-opts] the same token IS reported when linted without those opts (the guess really did run)",
  lintTokens(nameGuessDs).some((w) => /UNITLESS/.test(w)));
// The override must not swallow the OTHER warnings for that token — it only pre-empts the unit guess.
check("[RD-opts] opts.unitless does not suppress unrelated warnings",
  lintTokens({ variables: [{ name: "(Space 3)", type: "FLOAT", values: { v: 12 } }] }, { unitless: new Set(["(Space 3)"]) })
    .some((w) => /illegal in a CSS custom property/.test(w)));
// Emitter and linter must agree about which tokens the heuristic touched — same opts, same verdict.
check("[RD-opts] emitter agrees: opts.unitless drops the px",
  toCSS(nameGuessDs, overrideOpts).includes("--Opacity-disabled: 0.5;"));
// `font[-_ ]?weight` used to be unanchored, so a font-weight SCALE — a multiplier, the one case in the
// family where the unit matters — also matched.
check("[RD-bound] 'font-weight-scale' is NOT swept up by the font-weight name rule",
  toCSS({ variables: [{ name: "font-weight-scale/lg", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 2 } }] }).includes("--font-weight-scale-lg: 2px;"));
// The matching unit is the `/`-delimited GROUP, so the property may sit in any segment...
check("[RD-bound] the property may be a trailing segment ('text/font-weight')",
  toCSS({ variables: [{ name: "text/font-weight", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 600 } }] }).includes("--text-font-weight: 600;"));
// ...but a segment that merely CONTAINS it names something else.
check("[RD-bound] 'opacity-curve' is a different property, not an opacity",
  toCSS({ variables: [{ name: "motion/opacity-curve", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 3 } }] }).includes("--motion-opacity-curve: 3px;"));
// [RD-fold] "(Space 3)" is a real variable name; parens are illegal in a custom property and were
// folded to `---Space-3-` SILENTLY, breaking the never-silent guarantee.
check("[RD-fold] illegal chars in a token name are folded",
  toCSS({ variables: [{ name: "(Space 3)", type: "FLOAT", values: { v: 12 } }] }).includes("---Space-3-: 12px;"));
check("[RD-fold] and the fold is REPORTED by lintTokens",
  lintTokens({ variables: [{ name: "(Space 3)", type: "FLOAT", values: { v: 12 } }] }).some((w) => /illegal in a CSS custom property/.test(w) && /\(Space 3\)/.test(w)));
// ---------- [RD2-*] real-data regression from a live "🎨 Design System" export (Material 3 typography
// scale): a "Body 2" FLOAT is scoped to FONT_WEIGHT *and* FONT_SIZE/LINE_HEIGHT/LETTER_SPACING/
// PARAGRAPH_SPACING/PARAGRAPH_INDENT at once. `.some()` let the single unitless scope win, emitting
// `--Body-2: 18;` (invalid as a font-size) with no hygiene warning at all.
check("[RD2-mixed] a scope mix of FONT_WEIGHT + length scopes keeps px (majority-length wins)",
  toCSS({ variables: [{ name: "Body 2", type: "FLOAT", scopes: ["FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT"], values: { v: 18 } }] }).includes("--Body-2: 18px;"));
check("[RD2-pure] a PURE FONT_WEIGHT+OPACITY mix (no length scope) is still unitless",
  toCSS({ variables: [{ name: "w/x", type: "FLOAT", scopes: ["FONT_WEIGHT", "OPACITY"], values: { v: 500 } }] }).includes("--w-x: 500;"));
check("[RD-fold] a legal name is NOT reported as folded",
  !lintTokens({ variables: [{ name: "Neutral/Grey 800", type: "COLOR", values: { v: "#262626" } }] }).some((w) => /illegal in a CSS custom property/.test(w)));

// [T-empty] no emittable vars -> no empty `:root {}` block.
check("[T-empty] empty variable set emits no `:root` block", toCSS({ variables: [] }) === "" && toCSS({ variables: [{ name: "", type: "COLOR", values: { v: "#abcdef" } }] }) === "");
// [T-str-safe] a STRING token cannot break out of its declaration/block: `;` and `}` are CSS-hex-escaped.
check("[T-str-safe] STRING `;`/`}` are CSS-escaped (no declaration breakout)", toCSS({ variables: [{ name: "content/x", type: "STRING", values: { v: "a;b}c" } }] }).includes("--content-x: a\\3b b\\7d c;"));
// [T-str-plain] an ordinary font stack (commas/spaces only) passes through byte-for-byte.
check("[T-str-plain] ordinary STRING (font stack) passes through unescaped", toCSS({ variables: [{ name: "font/sans", type: "STRING", values: { v: "Inter, system-ui, sans-serif" } }] }).includes("--font-sans: Inter, system-ui, sans-serif;"));
// [T-str-lint] never-silent: the escape is also reported by lintTokens.
check("[T-str-lint] escaped STRING reported by lintTokens", lintTokens({ variables: [{ name: "c/x", type: "STRING", values: { v: "a}b" } }] }).some((w) => /CSS-structural/.test(w)));

console.log("drift — 3rd round:");
check("[F3-clean] id-matched component NOT falsely unmapped", driftLint({ version: 1, components: { "3:3": { figma: { name: "Card", id: "3:3" } } } }, { components: [{ id: "3:3", name: "Card", type: "COMPONENT" }] }).warnings.every((w) => w.code !== "unmapped-component"));
check("[multi-name] multi same-name orphan gives NO suggestedKey", (() => { const r = driftLint({ version: 1, components: { DEAD: { figma: { key: "DEAD", name: "Button" } } } }, { components: [{ key: "K1", name: "Button", type: "COMPONENT" }, { key: "K2", name: "Button", type: "COMPONENT" }] }); const o = r.errors.find((e) => e.code === "orphaned-entry"); return o && o.suggestedKey === undefined; })());
check("[kindless] map prop without kind -> no spurious kind-mismatch", driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { V: { codeProp: "v" } } } } }, single({ V: { type: "VARIANT", options: ["a"] } })).errors.every((e) => e.code !== "kind-mismatch"));
const collMap = { version: 1, components: { K: { figma: { key: "K" }, props: { Size: { kind: "enum", codeProp: "s", values: { a: "A" } } } } } };
const collA = { components: [{ key: "K", name: "B", type: "COMPONENT", props: { "Size": { type: "VARIANT", options: ["a"] }, "Size#2": { type: "BOOLEAN" } } }] };
const collB = { components: [{ key: "K", name: "B", type: "COMPONENT", props: { "Size#2": { type: "BOOLEAN" }, "Size": { type: "VARIANT", options: ["a"] } } }] };
check("[NEW1-drift] colliding catalog base -> ambiguous warn, order-independent, no kind-mismatch", driftLint(collMap, collA).errors.every((e) => e.code !== "kind-mismatch") && driftLint(collMap, collB).errors.every((e) => e.code !== "kind-mismatch") && driftLint(collMap, collA).warnings.some((w) => w.code === "ambiguous-prop"));

console.log("validator — 3rd round (uncovered rules):");
check("[V] invalid status rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, status: "bogus" } } }));
check("[V] figma.key non-string rejected", !ok({ version: 1, components: { K: { figma: { name: "B", key: 5 }, code: { module: "m", export: "E" } } } }));
check("[V] enum values object value rejected", !ok({ version: 1, components: { K: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { P: { kind: "enum", codeProp: "p", values: { a: {} } } } } } }));

console.log("bootstrap — 3rd round:");
check("[boot-unstable] fresh unpublished component flagged unstable", bootstrap({ components: [{ id: "9:9", name: "Loose", type: "COMPONENT" }] }).components["9:9"].figma.unstable === true);

// ================= FOURTH-ROUND: close proven survivors + the map-side ambiguity symmetry ==========
console.log("tokens — 4th round:");
check("[default-not-first] collection default drives :root even when NOT the first-listed mode", toCSS({ collections: [{ name: "C", modes: ["Dark", "Light"], default: "Light" }], variables: [{ name: "bg", type: "COLOR", collection: "C", values: { Dark: "#000000", Light: "#ffffff" } }] }).includes("--bg: #ffffff;"));
check("[exact-channel] color channel pinned to 4dp (kills near()-masking of precision loss)", toDTCG({ variables: [{ name: "c", type: "COLOR", values: { v: "#2563eb" } }] }).c.$value.components[0] === 0.1451);

console.log("drift — 4th round:");
const mAmbCat = { components: [{ key: "K", name: "B", type: "COMPONENT", props: { Size: { type: "VARIANT", options: ["a"] } } }] };
check("[NEW-mapside] colliding MAP base -> order-independent, no false kind-mismatch",
  driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { "Size#1": { kind: "enum", codeProp: "s", values: { a: "A" } }, "Size#2": { kind: "boolean", codeProp: "s2" } } } } }, mAmbCat).errors.every((e) => e.code !== "kind-mismatch") &&
  driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { "Size#2": { kind: "boolean", codeProp: "s2" }, "Size#1": { kind: "enum", codeProp: "s", values: { a: "A" } } } } } }, mAmbCat).errors.every((e) => e.code !== "kind-mismatch"));
check("[unknown-type] Figma prop type outside the 4 kinds -> no fabricated kind-mismatch", driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { N: { kind: "string", codeProp: "n" } } } } }, { components: [{ key: "K", name: "B", type: "COMPONENT", props: { N: { type: "NUMBER" } } }] }).errors.every((e) => e.code !== "kind-mismatch"));
check("[empty-variant] option mapped to \"\" is NOT flagged unmapped", driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { V: { kind: "enum", codeProp: "v", values: { a: "" } } } } } }, { components: [{ key: "K", name: "B", type: "COMPONENT", props: { V: { type: "VARIANT", options: ["a"] } } }] }).warnings.every((w) => w.code !== "unmapped-variant-value"));
check("[nonarray-options] non-array options -> no-variant-options warning, no crash", (() => { try { return driftLint({ version: 1, components: { K: { figma: { key: "K" }, props: { V: { kind: "enum", codeProp: "v", values: { a: "A" } } } } } }, { components: [{ key: "K", name: "B", type: "COMPONENT", props: { V: { type: "VARIANT", options: {} } } }] }).warnings.some((w) => w.code === "no-variant-options"); } catch (e) { return false; } })());
check("[cset-drift] unmapped COMPONENT_SET surfaced", driftLint({ version: 1, components: {} }, { components: [{ key: "SET", name: "Btn", type: "COMPONENT_SET", props: { Variant: { type: "VARIANT", options: ["a"] } } }] }).warnings.some((w) => w.code === "unmapped-component"));

console.log("validator — 4th round:");
check("[V] components as array rejected", !ok({ version: 1, components: [] }));
check("[V] figma as array rejected", !ok({ version: 1, components: { K: { figma: ["x"], code: { module: "m", export: "E" } } } }));

console.log("bootstrap — 4th round:");
check("[cset-boot] COMPONENT_SET bootstrapped as enum", (() => { const b = bootstrap({ components: [{ key: "SET", name: "Btn", type: "COMPONENT_SET", props: { Variant: { type: "VARIANT", options: ["a", "b"] } } }] }); return b.components.SET && b.components.SET.props.Variant.kind === "enum"; })());
check("[text-title] TEXT prop named Title -> children", bootstrap({ components: [{ key: "K", name: "B", type: "COMPONENT", props: { Title: { type: "TEXT" } } }] }).components.K.props.Title.codeProp === "children");
check("[boot-bool-coerce] non-boolean BOOLEAN default coerced to real boolean + valid", (() => { const m = bootstrap({ components: [{ key: "K", name: "B", type: "COMPONENT", props: { D: { type: "BOOLEAN", default: 1 } } }] }); return m.components.K.props.D.default === true && validateMap(m).ok; })());
check("[boot-id-refresh] preserve path refreshes figma.id from catalog", bootstrap({ components: [{ key: "K", id: "5:5", name: "B", type: "COMPONENT" }] }, { version: 1, components: { K: { figma: { key: "K", name: "B" }, code: { module: "@/k", export: "B" }, status: "active" } } }).components.K.figma.id === "5:5");
check("[boot-unstable-preserve] preserve path flags unpublished as unstable", bootstrap({ components: [{ id: "7:7", name: "Loose", type: "COMPONENT" }] }, { version: 1, components: { "7:7": { figma: { id: "7:7", name: "Loose" }, code: { module: "@/k", export: "L" }, status: "active" } } }).components["7:7"].figma.unstable === true);

console.log("security — reserved-key hardening:");
// Token maps are semi-trusted third-party dumps; a name like "__proto__/x" must NOT pollute Object.prototype.
check("[sec-proto-no-pollute] __proto__ token name does not mutate Object.prototype", (() => {
  toDTCG({ variables: [{ name: "__proto__/polluted", type: "COLOR", values: { v: "#112233" } }] }, []);
  return ({}).polluted === undefined && !("polluted" in {});
})());
check("[sec-proto-warns] reserved-key token is skipped with a warning", (() => {
  const w = []; const root = toDTCG({ variables: [{ name: "constructor/x", type: "COLOR", values: { v: "#112233" } }] }, w);
  return w.some((m) => /reserved key/.test(m)) && root.constructor === Object && !root.x;
})());
check("[sec-boot-proto-key] component keyed '__proto__' is kept, not dropped", (() => {
  const m = bootstrap({ components: [{ key: "__proto__", name: "Weird", type: "COMPONENT" }] });
  return Object.keys(m.components).includes("__proto__") && m.components["__proto__"].figma.name === "Weird";
})());
check("[sec-lint-proto-key] prop named '__proto__' is compared, not silently skipped", (() => {
  // Maps load via JSON.parse, which (unlike an object literal) creates a real own "__proto__" key.
  // A map prop '__proto__' absent on the Figma component must surface as stale-prop, not be skipped.
  const map = JSON.parse('{"version":1,"components":{"K":{"figma":{"key":"K","name":"B"},"code":{"module":"@/k","export":"B"},"props":{"__proto__":{"kind":"boolean","codeProp":"x"}}}}}');
  const cat = { components: [{ key: "K", name: "B", type: "COMPONENT", props: {} }] };
  const res = driftLint(map, cat);
  return res.errors.some((e) => e.code === "stale-prop" && e.prop === "__proto__");
})());

console.log("validator — prototype-named prop kinds:");
// KEYS.prop is keyed by an UNTRUSTED `kind` value. On a plain object literal, kind:"constructor"
// resolved to an inherited Object.prototype member — truthy, then `.includes` threw, turning a
// validation error into an uncaught TypeError and breaking "never throws on bad data".
const propMap = (kind) => ({ version: 1, components: { B: { figma: { name: "B" }, code: { module: "m", export: "E" }, props: { p: { kind, codeProp: "x" } } } } });
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
const strTok = (v) => ({ collections: [{ name: "C", modes: ["light"], default: "light" }], variables: [
  { name: "t", type: "STRING", collection: "C", values: { light: v } },
  { name: "after", type: "COLOR", collection: "C", values: { light: "#2563eb" } }] });
const survives = (v) => toCSS(strTok(v)).includes("--after");
const unclosedComment = (v) => { const c = toCSS(strTok(v)); return (c.match(/\/\*/g) || []).length !== (c.match(/\*\//g) || []).length; };
for (const [label, v] of [["comment-open", "Inter /*"], ["comment-close", "a */ b"], ["semicolon", "a;color:red"], ["brace", "a}"], ["unbalanced-paren", "cubic-bezier(0.4,0,0.2,1"], ["unbalanced-quote", '"Inter, sans-serif']]) {
  check(`[sec-css-${label}] token after the payload still survives`, survives(v) && !unclosedComment(v));
  check(`[sec-css-${label}] rewrite is reported by lintTokens`, lintTokens(strTok(v)).some((w) => /CSS-structural/.test(w)));
}
// Legitimate values contain parens/quotes/slashes and must pass through byte-for-byte — an escaper
// that mangled these would break every easing token and font stack in a real design system.
for (const [label, v] of [["easing", "cubic-bezier(0.4, 0, 0.2, 1)"], ["font-stack", '"Inter", sans-serif'], ["url", "url(/img.png)"], ["math", "2 * 4 / 2"]]) {
  check(`[css-legit-${label}] passes through unescaped`, toCSS(strTok(v)).includes(`--t: ${v};`));
  check(`[css-legit-${label}] not reported as rewritten`, !lintTokens(strTok(v)).some((w) => /CSS-structural/.test(w)));
}

console.log("security — reserved-key and breakout hardening in MODE NAMES:");
// Mode names are free-form designer strings (the Plugin API documents no restriction on
// addMode/renameMode) and reach the emitters through JSON.parse — which, unlike an object literal,
// creates a REAL own "__proto__" key. Both emitters key objects by mode name, so both were exposed:
// toCSS threw an uncaught TypeError (perMode.__proto__ is Object.prototype, which has no .push) and
// toDTCG silently dropped the mode (assigning to __proto__ sets the prototype, not an own key).
const modeDs = (mode) => JSON.parse(JSON.stringify({
  collections: [{ name: "Theme", modes: ["Light", mode], default: "Light", theming: true }],
  variables: [{ name: "color/bg", type: "COLOR", collection: "Theme", values: { Light: "#ffffff", [mode]: "#000000" } }],
}));
for (const mode of ["__proto__", "constructor", "prototype", "toString"]) {
  const ds = modeDs(mode);
  check(`[sec-mode-${mode}] toCSS does not throw`, (() => { try { toCSS(ds); return true; } catch (e) { return false; } })());
  check(`[sec-mode-${mode}] the mode's override block is emitted`, (() => {
    try { return toCSS(ds).includes("--color-bg: #000000;"); } catch (e) { return false; }
  })());
  check(`[sec-mode-${mode}] toDTCG keeps the mode in $extensions`, (() => {
    const leaf = toDTCG(ds).color.bg;
    const modes = (leaf.$extensions || {})["figma.com"].modes;
    // Round-trip through JSON: a prototype-assigned key would vanish here even if it read back live.
    return Object.keys(JSON.parse(JSON.stringify(modes))).includes(mode);
  })());
  check(`[sec-mode-${mode}] Object.prototype was not mutated`, ({}).Light === undefined);
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
// Live run #16: THREE variables called "Schemes/On Primary" with distinct keys put the identical
// declaration in :root three times and once more per mode block — 22 copies. Those resolve the same in
// every mode, so they are ONE declaration. But livetest-3 #44 showed the other half: two `Space 4` with
// distinct keys and DIFFERENT values (24 vs 16), where "last definition wins" shipped the wrong one.
// Those must BOTH be emitted, each under its own name, and never by input order.
(() => {
  const twins = {
    collections: [{ name: "M3", modes: ["Light", "Dark"], default: "Light" }, { name: "material-theme", modes: ["Light", "Dark"], default: "Light" }],
    variables: [
      { name: "Schemes/On Primary", key: "aaa1", type: "COLOR", collection: "M3", values: { Light: "#ffffff", Dark: "#111111" } },
      { name: "Schemes/On Primary", key: "bbb2", type: "COLOR", collection: "material-theme", values: { Light: "#ffffff", Dark: "#111111" } },
      { name: "Schemes/On Primary", key: "ccc3", type: "COLOR", collection: "material-theme", values: { Light: "#ffffff", Dark: "#111111" } },
    ],
  };
  const css = toCSS(twins);
  const root = (css.match(/:root \{([\s\S]*?)\}/) || ["", ""])[1];
  check("[dup-css] three IDENTICAL variables sharing a name emit ONE :root declaration, not three",
    (root.match(/--Schemes-On-Primary/g) || []).length === 1);
  const dark = (css.match(/\[data-theme="Dark"\] \{([\s\S]*?)\}/) || ["", ""])[1];
  check("[dup-css] and one per mode block too", (dark.match(/--Schemes-On-Primary/g) || []).length === 1);
  check("[dup-css] the identical twins are reported as such (naming the keys), not silently swallowed",
    lintTokens(twins).some((w) => /share the name 'Schemes\/On Primary'.*resolve identically in every mode — emitted ONCE/.test(w) && /aaa1/.test(w) && /ccc3/.test(w)));

  // The two real `Space 4` rows of livetest-3's design/export/variables.json (keys, values, scopes verbatim).
  const space4 = (order) => {
    const a = { name: "Space 4", key: "e26d506ea43ae0582896add59d9e04156fb3f6d5", type: "FLOAT", collection: "Spacing", scopes: ["WIDTH_HEIGHT", "GAP"], values: { "Mode 1": 24 } };
    const b = { name: "Space 4", key: "64928e3a5f094c0d9a2c916f50b98ff37c789882", type: "FLOAT", collection: "Spacing", scopes: ["GAP"], values: { Desktop: 16, Tablet: 8, Mobile: 8 } };
    return { collections: [{ name: "Spacing", modes: ["Mode 1"], default: "Mode 1" }, { name: "Spacing", modes: ["Desktop", "Tablet", "Mobile"], default: "Desktop" }], variables: order ? [a, b] : [b, a] };
  };
  const c1 = toCSS(space4(true)), c2 = toCSS(space4(false));
  check("[dup-css] two DIFFERENT variables sharing a name are both emitted, each carrying its key (livetest-3 #44)",
    /--Space-4-e26d506e: 24px;/.test(c1) && /--Space-4-64928e3a: 16px;/.test(c1) && !/--Space-4:/.test(c1));
  check("[dup-css] and input ORDER changes nothing about which name each value gets",
    /--Space-4-e26d506e: 24px;/.test(c2) && /--Space-4-64928e3a: 16px;/.test(c2));
  const w = lintTokens(space4(true));
  check("[dup-css] the warning names BOTH keys and BOTH values, and no longer claims a 'later definition wins'",
    w.some((m) => /e26d506e/.test(m) && /64928e3a/.test(m) && /"Mode 1":24/.test(m) && /"Desktop":16/.test(m) && /resolve DIFFERENTLY/.test(m)) && !w.some((m) => /later definition wins/.test(m)));
  const d = toDTCG(space4(false));
  check("[dup-dtcg] tokens.dtcg.json keeps both too, with the Figma key under $extensions",
    !!d["Space-4-e26d506e"] && d["Space-4-e26d506e"].$value.value === 24 && d["Space-4-64928e3a"].$value.value === 16
    && d["Space-4-e26d506e"].$extensions["figma.com"].key === "e26d506ea43ae0582896add59d9e04156fb3f6d5");
  check("[dup-css] distinct names are untouched — the dedup keys on the emitted property, not on being a dup",
    (toCSS({ collections: [{ name: "A", modes: ["M"], default: "M" }], variables: [
      { name: "a/one", type: "COLOR", collection: "A", values: { M: "#111" } },
      { name: "a/two", type: "COLOR", collection: "A", values: { M: "#222" } }] }).match(/--a-/g) || []).length === 2);
})();

// ---------- --web tailwind: the web counterpart of --native (live run #18) ----------------------
(() => {
  const twDs = {
    collections: [{ name: "Theme", modes: ["Light", "Dark"], default: "Light" }],
    variables: [
      { name: "gray/900", type: "COLOR", collection: "Theme", values: { Light: "#121319", Dark: "#121319" } },
      { name: "color/primary", type: "COLOR", collection: "Theme", values: { Light: "#dec9ff", Dark: "#381e72" } },
      { name: "bg/side-menu", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "gray/900" }, Dark: { aliasOf: "gray/900" } } },
      { name: "space/md", type: "FLOAT", collection: "Theme", values: { Light: 16, Dark: 16 } },
      { name: "radius/card", type: "FLOAT", collection: "Theme", scopes: ["CORNER_RADIUS"], values: { Light: 12, Dark: 12 } },
      { name: "text/body", type: "FLOAT", collection: "Theme", scopes: ["FONT_SIZE"], values: { Light: 14, Dark: 14 } },
      { name: "opacity/disabled", type: "FLOAT", collection: "Theme", scopes: ["OPACITY"], values: { Light: 0.5, Dark: 0.5 } },
    ],
  };
  const tw = toTailwind(twDs);
  // Tailwind v4 generates a utility from the NAMESPACE, so filing a token under the wrong one gives
  // a custom property no class can reach. Each kind must land under the namespace that earns it.
  check("[tw] colors -> --color-figma-*, spacing -> --spacing-figma-*, radius -> --radius-figma-*, font size -> --text-figma-*",
    /--color-figma-color-primary: #dec9ff;/.test(tw.text) && /--spacing-figma-space-md: 16px;/.test(tw.text)
    && /--radius-figma-radius-card: 12px;/.test(tw.text) && /--text-figma-text-body: 14px;/.test(tw.text));
  check("[tw] a unitless FLOAT matches no namespace — emitted as a plain --figma-* property rather than filed wrongly or dropped",
    /\n {2}--figma-opacity-disabled: 0\.5;/.test(tw.text) && !/--spacing-figma-opacity-disabled/.test(tw.text));
  check("[tw] an alias points at its TARGET's namespaced name, not the referrer's and not tokens.css's",
    /--color-figma-bg-side-menu: var\(--color-figma-gray-900\);/.test(tw.text));
  check("[tw] the file imports tailwind and opens a @theme block", /^@import "tailwindcss";/.test(tw.text) && /@theme \{/.test(tw.text));
  // @theme cannot be nested in a selector, so non-default modes reassign the same properties outside it.
  const modeBlock = (tw.text.match(/\[data-theme="Dark"\] \{([\s\S]*?)\}/) || ["", ""])[1];
  check("[tw] a non-default mode reassigns the same custom properties OUTSIDE @theme",
    /--color-figma-color-primary: #381e72;/.test(modeBlock) && tw.text.indexOf("@theme") < tw.text.indexOf('[data-theme="Dark"]'));
  check("[tw] a value identical across modes is not repeated in the mode block", !/--spacing-figma-space-md/.test(modeBlock));
  check("[tw] counts distinguish tokens emitted from tokens that actually generate a utility",
    tw.tokens === 7 && tw.utilities === 6);
  check("[tw] the SAME variable listed twice is one declaration (its last record)", (() => {
    const d = toTailwind({ collections: [{ name: "A", modes: ["M"], default: "M" }], variables: [
      { name: "on/primary", key: "k1", type: "COLOR", collection: "A", values: { M: "#fff" } },
      { name: "on/primary", key: "k1", type: "COLOR", collection: "A", values: { M: "#000" } }] });
    return (d.text.match(/--color-figma-on-primary:/g) || []).length === 1 && /#000000/.test(d.text) && !d.warnings.length;
  })());
  // livetest-3 #94: `Space 3` (16) and `(Space 3)` (12) are different NAMES that only collide after
  // slugging, so they got no "duplicate" warning and the theme silently kept 12. Collisions are now
  // detected on the EMITTED name, and the name spelled exactly as the identifier keeps it.
  check("[tw] two names that fold onto one Tailwind name are both emitted, and the run SAYS so (livetest-3 #94)", (() => {
    const d = toTailwind({ collections: [{ name: "Spacing", modes: ["Mode 1"], default: "Mode 1" }], variables: [
      { name: "(Space 3)", key: "a96c665bae7a1989c41dd71440cfd9b0a0c0ba4f", type: "FLOAT", collection: "Spacing", scopes: ["GAP"], values: { "Mode 1": 12 } },
      { name: "Space 3", key: "a9aa73e78e34066545c67621b5f7aef9ab89a4f1", type: "FLOAT", collection: "Spacing", scopes: ["GAP"], values: { "Mode 1": 16 } }] });
    return /--spacing-figma-space-3: 16px;/.test(d.text) && /--spacing-figma-space-3-a96c665b: 12px;/.test(d.text)
      && d.warnings.some((w) => /'Space 3'/.test(w) && /'\(Space 3\)'/.test(w) && /a96c665b/.test(w) && /a9aa73e7/.test(w));
  })());
  // livetest-3 #183: `--radius-xl: 16px` in @theme REPLACED Tailwind's own rounded-xl (12px).
  check("[tw] no generated variable can shadow Tailwind's own scale — radius XL/L/S/Full land under figma- (livetest-3 #183)", (() => {
    const d = toTailwind({ collections: [{ name: "Border Radius", modes: ["Mode 1"], default: "Mode 1" }], variables: ["S", "L", "XL", "Full"].map((n, i) => (
      { name: n, key: "r" + i, type: "FLOAT", collection: "Border Radius", scopes: ["CORNER_RADIUS", "FONT_VARIATIONS"], values: { "Mode 1": [4, 12, 16, 1000000000][i] } })) });
    return !/^ {2}--radius-(xl|l|s|full):/m.test(d.text) && /--radius-figma-xl: 16px;/.test(d.text) && /--radius-figma-l: 12px;/.test(d.text);
  })());
  check("[tw] Figma's 1e9 'fully rounded' sentinel is emitted as 9999px, never as 1000000000px (livetest-3 #96)", (() => {
    const ds = { collections: [{ name: "Border Radius", modes: ["Mode 1"], default: "Mode 1" }], variables: [
      { name: "Full", key: "ba82", type: "FLOAT", collection: "Border Radius", scopes: ["CORNER_RADIUS"], values: { "Mode 1": 1000000000 } }] };
    const t = toTailwind(ds).text, c = toCSS(ds), j = toDTCG(ds);
    return /--radius-figma-full: 9999px;/.test(t) && /--Full: 9999px;/.test(c) && !/1000000000/.test(t + c)
      && j.Full.$value.value === 9999 && j.Full.$extensions["figma.com"].sentinel.figmaValue === 1000000000;
  })());
  check("[tw] a mode name cannot break out of its attribute selector (same escaping toCSS uses)",
    !/dark"\]/.test(toTailwind({ collections: [{ name: "A", modes: ["Light", 'dark"] * { display: none } [x="'], default: "Light" }],
      variables: [{ name: "c", type: "COLOR", collection: "A", values: { Light: "#fff", 'dark"] * { display: none } [x="': "#000" } }] }).text));
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
// Live-run finding #15: a --node/single-screen pull never writes design/design-system/, so every
// one of these CLIs is routinely pointed at a file that legitimately does not exist. Dying with a
// raw stack whose top frame is a line number inside this repo reads like the tool broke. These run
// as real subprocesses because the behaviour under test IS the process exit + what lands on stderr.
(() => {
  const { spawnSync } = require("child_process");
  const D2C = path.join(__dirname, "..", "design-to-code");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "d2c-enoent-"));
  const run = (script, args) => spawnSync(process.execPath, [path.join(D2C, script), ...args], { encoding: "utf8", cwd });
  const GONE = "design/design-system/components.local.json";
  const cases = [
    ["map-bootstrap.js", [GONE, "--out", "codeconnect.local.json"], /component catalog/],
    ["drift-lint.js", ["codeconnect.local.json", GONE], /component catalog/],
    ["tokens.js", ["design/design-system/tokens.json", "out"], /token catalog/],
    ["map-validate.js", ["codeconnect.local.json"], /component map/],
    ["audit.js", ["design/Nope.json"], /screen export/],
    ["design-diff.js", ["design/Nope.json"], /export/],
  ];
  for (const [script, args, what] of cases) {
    const r = run(script, args);
    const err = r.stderr || "";
    check(`[enoent-${script}] a missing input exits 2 with one 'does not exist' line, no stack`,
      r.status === 2 && /^error {2}/m.test(err) && what.test(err) && /does not exist/.test(err)
      && !/ENOENT/.test(err) && !/\n {4}at /.test(err));
  }
  // The hint is the actionable half: it must name the pull that WOULD create the missing file.
  const boot = run("map-bootstrap.js", [GONE, "--out", "codeconnect.local.json"]).stderr;
  check("[enoent-hint] the catalog tools explain that a single-screen pull writes no design-system/",
    /--design-system/.test(boot) && /--node/.test(boot) && /every instance then counts as new/.test(boot));
  check("[enoent-hint] tokens.js points at the file a single-screen pull DOES write",
    /design\/variables\.json/.test(run("tokens.js", ["design/design-system/tokens.json", "out"]).stderr));
  // …and a file that exists but is not JSON is its own sentence, not a SyntaxError stack.
  fs.writeFileSync(path.join(cwd, "broken.json"), "{oops");
  const bad = run("map-validate.js", ["broken.json"]);
  check("[enoent-badjson] unparseable JSON is reported as such, with the parser's reason",
    bad.status === 2 && /is not valid JSON/.test(bad.stderr) && !/\n {4}at /.test(bad.stderr));
  // Guard the opposite direction: a file that IS there must still be processed normally.
  fs.writeFileSync(path.join(cwd, "ok.json"), JSON.stringify({ version: 1, components: {} }));
  check("[enoent-negative] an existing, valid file is unaffected by the guard",
    run("map-validate.js", ["ok.json"]).status === 0);
})();

// ---------- get-component.js: resolve a catalog entry -> its variantsFile detail -----------------
(() => {
  const gcDs = {
    exportedAt: "2026-08-18T00:00:00.000Z", file: "Demo", colorProfile: "srgb",
    collections: [], variables: [], styles: { paint: [], text: [], effect: [], grid: [] }, hygiene: [],
    components: [
      { key: "kset", name: "Badge", type: "COMPONENT_SET", id: "9:1", page: "P", pageId: "1:0",
        variants: [{ id: "9:2", name: "Size=Sm", key: "vk", values: { Size: "Sm" }, node: { type: "COMPONENT", name: "Size=Sm" } }] },
      { key: "kflat", name: "Icon", type: "COMPONENT_SET", id: "9:3", page: "P", pageId: "1:0",
        variants: [{ id: "9:4", name: "State=Default", key: "vk2", values: { State: "Default" } }] }, // no node -> no variantsFile
      { key: "kdup", name: "Same", id: "9:5", type: "COMPONENT" },
      { key: "kdup2", name: "Same", id: "9:6", type: "COMPONENT" },
      { key: "ksolo", name: "IconButton", id: "9:7", type: "COMPONENT", page: "P", pageId: "1:0",
        node: { type: "COMPONENT", name: "IconButton", fills: [] } }, // standalone COMPONENT, not a variant in a set
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
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));

  check("[get-component] resolves by key", findComponent(catalog, "kset").id === "9:1");
  check("[get-component] resolves by id", findComponent(catalog, "9:1").key === "kset");
  check("[get-component] resolves by name when unique", findComponent(catalog, "Icon").key === "kflat");
  check("[get-component] unresolved handle returns null", findComponent(catalog, "nope") === null);
  check("[get-component] ambiguous name throws rather than guessing", (() => {
    try { findComponent(catalog, "Same"); return false; } catch (e) { return e.code === "ambiguous-name"; }
  })());

  const res = getComponent(catalogFile, "kset");
  check("[get-component] found + variantsFile followed to the real node tree", res.found && res.detail && res.detail.variants[0].node.type === "COMPONENT");
  check("[get-component] detail carries setId/setKey/name + the stamp", res.detail.setId === "9:1" && res.detail.setKey === "kset" && res.detail.name === "Badge" && res.detail.exportedAt === "2026-08-18T00:00:00.000Z");

  const noNode = getComponent(catalogFile, "kflat");
  check("[get-component] a set with no exported node trees has no variantsFile and no detail", noNode.found && !("variantsFile" in noNode.component) && noNode.detail === null);

  check("[get-component] not-found handle reports found:false", getComponent(catalogFile, "nope").found === false);

  const solo = getComponent(catalogFile, "ksolo");
  check("[get-component] a standalone COMPONENT's slim entry carries nodeFile, not .node", solo.found && !("node" in solo.component) && typeof solo.component.nodeFile === "string");
  check("[get-component] and nodeFile resolves to the real node tree", solo.detail && solo.detail.node && solo.detail.node.name === "IconButton");
  check("[get-component] standalone-COMPONENT detail carries id/key/name + the stamp", solo.detail.id === "9:7" && solo.detail.key === "ksolo" && solo.detail.name === "IconButton" && solo.detail.exportedAt === "2026-08-18T00:00:00.000Z");

  fs.rmSync(tmp, { recursive: true, force: true });
})();

// ---------- native token files (tokens-native.js) ----------
(() => {
  const { toNative, platformOf } = require("../design-to-code/tokens");
  const nds = {
    collections: [{ name: "Theme", modes: ["Light", "Dark"], default: "Light" }, { name: "Primitive", modes: ["Mode 1"], default: "Mode 1" }, { name: "Font Sizes", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [
      { name: "Blue/500", type: "COLOR", collection: "Primitive", values: { "Mode 1": "#1A2B3C" }, scopes: ["ALL_SCOPES"] },
      { name: "Blue/200", type: "COLOR", collection: "Primitive", values: { "Mode 1": "#AABBCC80" }, scopes: ["ALL_SCOPES"] },
      { name: "Space/MD", type: "FLOAT", collection: "Primitive", values: { "Mode 1": 16 }, scopes: ["GAP"] },
      { name: "opacity/disabled", type: "FLOAT", collection: "Primitive", values: { "Mode 1": 0.4 }, scopes: ["OPACITY"] },
      { name: "Body", type: "FLOAT", collection: "Font Sizes", values: { "Mode 1": 14 }, scopes: ["ALL_SCOPES"] },
      { name: "Primary/Primary", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "Blue/500" }, Dark: { aliasOf: "Blue/200" } }, scopes: ["ALL_SCOPES"] },
      { name: "class", type: "COLOR", collection: "Theme", values: { Light: "#ffffff", Dark: "#000000" }, scopes: ["ALL_SCOPES"] },
      { name: "light", type: "COLOR", collection: "Theme", values: { Light: "#ffffff", Dark: "#000000" }, scopes: ["ALL_SCOPES"] },
      { name: "Primary primary", type: "COLOR", collection: "Theme", values: { Light: "#111111", Dark: "#222222" }, scopes: ["ALL_SCOPES"] },
      { name: "From/Library", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "Not/Exported" }, Dark: "#000000" }, scopes: ["ALL_SCOPES"] },
      { name: "Loop/A", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "Loop/A" }, Dark: { aliasOf: "Loop/A" } }, scopes: ["ALL_SCOPES"] },
    ],
  };
  const kt = toNative(nds, "android-compose", { package: "com.acme.ui" }), sw = toNative(nds, "swiftui"), da = toNative(nds, "flutter"), ts = toNative(nds, "react-native");
  check("[native] profile names resolve; an unknown platform throws", platformOf("android-compose") === "compose" && platformOf("nope") === null && (() => { try { toNative(nds, "nope"); return false; } catch { return true; } })());
  check("[native] file names per platform", kt.file === "DesignTokens.kt" && sw.file === "DesignTokens.swift" && da.file === "design_tokens.dart" && ts.file === "designTokens.ts");
  check("[native] aliases resolve PER MODE into concrete values (Light→Blue/500, Dark→Blue/200 with alpha as AARRGGBB)",
    /ThemeTokensLightMode = ThemeTokens\([\s\S]*?primaryPrimary = Color\(0xFF1A2B3C\)/.test(kt.text) && /ThemeTokensDark = ThemeTokens\([\s\S]*?primaryPrimary = Color\(0x80AABBCC\)/.test(kt.text)
    && !/ThemeTokensDark = ThemeTokens\([\s\S]*?primaryPrimary = Color\(0xFF1A2B3C\)/.test(kt.text));
  check("[native] compose: data class + CompositionLocal defaulting to the collection's default mode, package honoured",
    /^package com\.acme\.ui$/m.test(kt.text) && /@Immutable\ndata class ThemeTokens\(/.test(kt.text) && /val LocalThemeTokens = staticCompositionLocalOf \{ ThemeTokensLightMode \}/.test(kt.text));
  check("[native] compose units: spacing → dp, font size → sp (by name under ALL_SCOPES), opacity → unitless Float",
    /val spaceMD: Dp = 16\.dp/.test(kt.text) && /val body: TextUnit = 14\.sp/.test(kt.text) && /val opacityDisabled: Float = 0\.4f/.test(kt.text));
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
    const t = toNative({ collections: [{ name: "Sizes", modes: ["Desktop", "Mobile"], default: "Desktop" }, { name: "Theme", modes: ["Light", "Dark"], default: "Light" }], variables: [{ name: "gap", type: "FLOAT", collection: "Sizes", values: { Desktop: 24, Mobile: 16 } }, { name: "bg", type: "COLOR", collection: "Theme", values: { Light: "#fff", Dark: "#000" } }] }, "swiftui").text;
    return /\\\.sizesTokens, \.mobile \/\* one of: \.desktop, \.mobile/.test(t) && /\\\.themeTokens, colorScheme == \.dark \? \.dark : \.light\)/.test(t) && !/sizesTokens, colorScheme/.test(t);
  })());
  check("[native] swiftui: a control character is escaped the Swift way (\\u{1}), not the JSON way", /"a\\u\{0001\}b"/.test(toNative({ collections: [{ name: "S", modes: ["M"], default: "M" }], variables: [{ name: "s", type: "STRING", collection: "S", values: { M: "a\u0001b" } }] }, "swiftui").text));
  check("[native] compose: the JVM limit is counted in parameter UNITS (Color = 2) — 130 colors in a themed collection warns, 100 does not", (() => {
    const ds = (n) => ({ collections: [{ name: "Big", modes: ["Light", "Dark"], default: "Light" }], variables: Array.from({ length: n }, (_, i) => ({ name: "c/" + i, type: "COLOR", collection: "Big", values: { Light: "#fff", Dark: "#000" } })) });
    return toNative(ds(130), "android-compose").warnings.some((w) => /JVM parameter units/.test(w)) && !toNative(ds(100), "android-compose").warnings.some((w) => /JVM/.test(w));
  })());
  check("[native] prototype-named modes/tokens cannot break the emitter", (() => { try { toNative({ collections: [{ name: "__proto__", modes: ["__proto__", "constructor"], default: "__proto__" }], variables: [{ name: "__proto__", type: "COLOR", collection: "__proto__", values: { __proto__: "#fff", constructor: "#000" } }] }, "flutter"); return true; } catch { return false; } })());
})();

// ---------- P6-123: drift-lint CLI must exit non-zero at 0% screen coverage (not a bug, but pin it) ----------
// Finding 123 claimed `--screen` printed ERROR [screen-coverage]/[catalog-rekeyed] yet exited 0.
// Reproduced directly against the real livetest-3 map/catalog/screens (both the Job Role Details
// export and the positions export, 0% coverage in both): the CLI exits 1 both times, run directly
// AND through a pipe. Not reproducible on head — recorded here as a regression pin so a future
// change cannot silently reintroduce it.
{
  const { spawnSync } = require("child_process");
  const FXL = path.join(__dirname, "fixtures", "livetest3");
  const emptyMapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p6-123-")), "map.json");
  fs.writeFileSync(emptyMapFile, JSON.stringify({ components: {} }));
  const catalogFile = path.join(FXL, "design-system", "components.local.json");
  const screens = [
    path.join(FXL, "verify", "positions___7314_87192.json"),
    path.join(FXL, "verify", "System_Configurations__1359_21337.json"),
  ];
  for (const screen of screens) {
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "design-to-code", "drift-lint.js"), emptyMapFile, catalogFile, "--screen", screen], { encoding: "utf8" });
    check(`[P6-123] drift-lint --screen exits non-zero at 0% coverage for ${path.basename(screen)}`, r.status !== 0 && /ERROR\s+\[(screen-coverage|catalog-rekeyed)\]/.test(r.stderr));
  }
}

// ---------- map-bootstrap.js --screen scopes the catalog to what one screen actually uses (P4 #103) ----------
// Before the fix, a full bootstrap on a real catalog stubbed EVERY component in it (59 here, 318 on
// the live run) regardless of the screen about to be built — a confirm list nobody can evaluate.
// --screen filters that down to the keys/ids the screen's own VISIBLE instances reference.
(() => {
  const { spawnSync } = require("child_process");
  const D2C = path.join(__dirname, "..", "design-to-code");
  const FXL = path.join(__dirname, "fixtures", "livetest3");
  const catalog = path.join(FXL, "design-system", "components.local.json");
  const screen = path.join(FXL, "pages", "__Organization_management_", "positions___7314_87192.json");
  const full = JSON.parse(spawnSync(process.execPath, [path.join(D2C, "map-bootstrap.js"), catalog], { encoding: "utf8" }).stdout);
  const scopedRun = spawnSync(process.execPath, [path.join(D2C, "map-bootstrap.js"), catalog, "--screen", screen], { encoding: "utf8" });
  const scoped = JSON.parse(scopedRun.stdout);
  const fullCount = Object.keys(full.components).length;
  const scopedCount = Object.keys(scoped.components).length;
  // This fixture screen is the 0%-catalog-match case (finding 103's own scenario: 0 of the screen's
  // instance keys are in this catalog), so the scoped count is legitimately 0 — the point is that it
  // is never the full 59, i.e. it never asks the user to confirm components the screen doesn't use.
  check("[map-bootstrap --screen] scopes to fewer components than a full bootstrap", scopedCount < fullCount);
  check("[map-bootstrap --screen] says on stderr how much it scoped, from -> to", new RegExp(`from ${fullCount} to ${scopedCount}`).test(scopedRun.stderr));
})();

// ---------- finding 313: a consumer-project path that does not exist in a consumer project --------
// `design-to-code/<script>.js` is only a valid path INSIDE this repo. A consumer project has only
// the plugin's own `${CLAUDE_PLUGIN_ROOT}/scripts/<script>.js` — a skill quoting the repo-relative
// path hands the model a command that fails with `Cannot find module` the moment it runs. Comments
// inside the GENERATED claude-plugin/scripts/*.js (the build banner, which legitimately says where
// the source lives) and help/references/troubleshooting.md's explicit "working from a clone of the
// repo instead" alternative are the only allowed exceptions; neither is a *.md under skills/ or
// agents/ telling the model what command to run.
(() => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".md") ? [path.join(d, e.name)] : []);
  const PLUGIN_ROOT = path.join(__dirname, "..", "claude-plugin");
  const offenders = [];
  for (const f of [...walk(path.join(PLUGIN_ROOT, "skills")), ...walk(path.join(PLUGIN_ROOT, "agents"))]) {
    const rel = path.relative(PLUGIN_ROOT, f);
    if (rel === path.join("skills", "help", "references", "troubleshooting.md")) continue; // explicit "cloned repo" alternative, not a command to run in a consumer project
    const text = fs.readFileSync(f, "utf8");
    if (/design-to-code\//.test(text)) offenders.push(rel);
  }
  check("[313] no skill/agent doc quotes the repo-relative design-to-code/ path — every script is ${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js" +
    (offenders.length ? " — offenders: " + offenders.join(", ") : ""), offenders.length === 0);
})();

report();
