// Offline tests for the tooling/ layer. No Figma, no dependencies:  node test/tooling.test.js
// Hardened after an adversarial review — assertions pin VALUES (not just presence) and every
// confirmed finding has a regression test. Tags: [Fn]/[An]/[Mn]/[Bn] map to review finding ids.
const { toDTCG, toCSS, lintTokens, hexToColorValue, cssVarName } = require("../tooling/tokens");
const { validateMap } = require("../tooling/map-validate");
const { driftLint } = require("../tooling/drift-lint");
const { bootstrap } = require("../tooling/map-bootstrap");
const { isManifest } = require("../tooling/catalog-input");
const { check, report } = require("./assert");

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
check("FLOAT -> number + literal value", dtcg.space.md.$type === "number" && dtcg.space.md.$value === 16);
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

// ---------- tokens: never-silent lint (H1/H3/H7/H8) ----------
console.log("tokens — lint:");
check("[H1] group/leaf collision reported (no silent loss)", lintTokens({ variables: [{ name: "color", type: "COLOR", values: { v: "#111111" } }, { name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }] }).some((w) => /collide/.test(w)));
check("[H1] collision does not produce an illegal both-$value-and-child node", (() => { const d = toDTCG({ variables: [{ name: "color", type: "COLOR", values: { v: "#111111" } }, { name: "color/primary", type: "COLOR", values: { v: "#2563eb" } }] }); return !(d.color && d.color.$value !== undefined && d.color.primary); })());
check("[H3] no-value-in-any-mode reported + skipped", (() => { const w = []; const d = toDTCG({ variables: [{ name: "x", type: "COLOR", values: {} }] }, w); return w.some((m) => /no value/.test(m)) && d.x === undefined; })());
check("[H3] toCSS never emits `undefined`", !toCSS({ collections: [{ name: "C", modes: ["Light", "Dark"], default: "Light" }], variables: [{ name: "bg", type: "COLOR", collection: "C", values: { Dark: "#000000" } }] }).includes("undefined"));
check("[H7] dangling alias reported", lintTokens({ variables: [{ name: "a", type: "COLOR", values: { v: { aliasOf: "does/not/exist" } } }] }).some((w) => /undefined token/.test(w)));
check("[H8] empty-name skipped in CSS (no `--:`)", !toCSS({ variables: [{ name: "", type: "COLOR", values: { v: "#abcdef" } }] }).includes("--:"));
check("[H6b] var-name collision from distinct names reported", lintTokens({ variables: [{ name: "spacing/4", type: "FLOAT", values: { v: 16 } }, { name: "spacing-4", type: "FLOAT", values: { v: 99 } }] }).some((w) => /multiple tokens/.test(w)));

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
const { checkFreshness, DEFAULT_MAX_AGE_MS } = require("../tooling/drift-lint");
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
  lintTokens({ variables: [{ name: "Opacity/disabled", resolvedType: "FLOAT", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 0.5 } }] })
    .some((w) => /Opacity\/disabled/.test(w) && /UNITLESS/.test(w)));
check("[RD-say] but a token the SCOPES decided is not reported (no noise on an explicit signal)",
  !lintTokens({ variables: [{ name: "opacity/disabled", resolvedType: "FLOAT", type: "FLOAT", scopes: ["OPACITY"], values: { v: 0.5 } }] })
    .some((w) => /UNITLESS/.test(w)));
// numberUnit short-circuits on opts.unitless BEFORE the name heuristic, so a token the caller named
// explicitly never reaches the guess. lintTokens has to take the same opts or it warns about a guess
// that was never made — and tells the caller to go fix it in Figma when they already fixed it here.
const nameGuessDs = { variables: [{ name: "Opacity/disabled", resolvedType: "FLOAT", type: "FLOAT", scopes: ["ALL_SCOPES"], values: { v: 0.5 } }] };
const overrideOpts = { unitless: new Set(["Opacity/disabled"]) };
check("[RD-opts] a token overridden via opts.unitless is NOT reported as a name guess",
  !lintTokens(nameGuessDs, overrideOpts).some((w) => /UNITLESS/.test(w)));
check("[RD-opts] the same token IS reported when linted without those opts (the guess really did run)",
  lintTokens(nameGuessDs).some((w) => /UNITLESS/.test(w)));
// The override must not swallow the OTHER warnings for that token — it only pre-empts the unit guess.
check("[RD-opts] opts.unitless does not suppress unrelated warnings",
  lintTokens({ variables: [{ name: "(Space 3)", resolvedType: "FLOAT", type: "FLOAT", values: { v: 12 } }] }, { unitless: new Set(["(Space 3)"]) })
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

report();
