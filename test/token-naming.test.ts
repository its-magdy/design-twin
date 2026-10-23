// test/token-naming.test.ts — the names a Figma variable gets on every target (design-to-code/token-naming.ts), and the
// round trip the Stop hook depends on: every name the emitters actually write (tokens.css, theme.css, the four native
// files) is recognised by the gate as that token's definition when the plan names it the way a builder writes it — and a
// near miss is not.
// Run with:  bun test/token-naming.test.ts
import { toCSS, toTailwind } from "../design-to-code/tokens.ts";
import { toNative } from "../design-to-code/tokens-native.ts";
import { TW_PREFIX, cssVarName, disambiguated, keyTag, namesToken, nativeIdentifier, requiredCustomProps, tailwindVarName } from "../design-to-code/token-naming.ts";
import { colorLiterals, literalUses, scanText } from "../design-to-code/code-scanner.ts";
import { colorKey } from "../design-to-code/color.ts";
import { tokens } from "./fixtures.ts";
import { check, report } from "./assert.ts";

console.log("forward — the name on each target:");
check("[css] cssVarName keeps case and folds every non-[A-Za-z0-9-] character", cssVarName("Schemes/On Primary") === "--Schemes-On-Primary" && cssVarName("a/(b)") === "--a--b-");
check("[tailwind] every kind sits under its namespace and the figma- prefix; an unknown kind under --figma-",
  TW_PREFIX === "figma-" && tailwindVarName("Brand/600", "color") === "--color-figma-brand-600" && tailwindVarName("Space 4", "dimension") === "--spacing-figma-space-4"
  && tailwindVarName("Radius/XL", "radius") === "--radius-figma-radius-xl" && tailwindVarName("Type/Body", "fontSize") === "--text-figma-type-body"
  && tailwindVarName("Font/Body", "fontFamily") === "--font-figma-font-body" && tailwindVarName("Opacity/Disabled", null) === "--figma-opacity-disabled"
  && tailwindVarName("(Space 3)", "dimension") === "--spacing-figma-space-3" && tailwindVarName("!!!", "color") === "--color-figma-token");
check("[native] camelCase from the segments; a leading digit and a reserved word are made legal",
  nativeIdentifier(["Schemes", "On Primary"]) === "schemesOnPrimary" && nativeIdentifier(["4xl"]) === "n4xl" && nativeIdentifier(["default"]) === "defaultToken" && nativeIdentifier([]) === "token");
check("[key] the key tag is the key's first 8 characters, lower-cased; none without a key",
  keyTag("E26D506EAAAA") === "e26d506e" && keyTag("") === null && keyTag(undefined) === null);
check("[key] a colliding identifier carries the tag: `-` on the web, `_` in native code",
  disambiguated("--Space-4", "e26d506e", "css") === "--Space-4-e26d506e" && disambiguated("space4", "e26d506e", "native") === "space4_e26d506e");

// ---------------------------------------------------------------- the round trip
// One design system with every naming path in it: a two-mode colour, a name with a space, two different variables
// sharing a name (each emitted with its key tag), a radius, a font size, a font family and a unitless opacity.
const ds = tokens({
  collections: [{ name: "Colors", modes: ["Light", "Dark"], default: "Light" }, { name: "Spacing", modes: ["Mode 1"], default: "Mode 1" }],
  variables: [
    { name: "Brand/600", type: "COLOR", collection: "Colors", key: "aaaa1111bbbb", values: { Light: "#5B5FC7", Dark: "#112233" } },
    { name: "Schemes/On Primary", type: "COLOR", collection: "Colors", key: "bbbb2222cccc", values: { Light: "#FFFFFF", Dark: "#1B1B21" } },
    { name: "Space 4", type: "FLOAT", collection: "Spacing", key: "e26d506eaaaa", values: { "Mode 1": 24 } },
    { name: "Space 4", type: "FLOAT", collection: "Spacing", key: "f00dbabe1111", values: { "Mode 1": 16 } },
    { name: "Radius/XL", type: "FLOAT", collection: "Spacing", key: "cccc3333dddd", scopes: ["CORNER_RADIUS"], values: { "Mode 1": 12 } },
    { name: "Type/Body Size", type: "FLOAT", collection: "Spacing", key: "dddd4444eeee", scopes: ["FONT_SIZE"], values: { "Mode 1": 14 } },
    { name: "Font/Body", type: "STRING", collection: "Spacing", key: "eeee5555ffff", scopes: ["FONT_FAMILY"], values: { "Mode 1": "Inter" } },
    { name: "Opacity/Disabled", type: "FLOAT", collection: "Spacing", key: "ffff6666aaaa", scopes: ["OPACITY"], values: { "Mode 1": 40 } },
  ],
});

// What each variable is called on each target, and how a builder spells it in a plan's codeToken there.
interface Row { name: string; hexes: string[]; css: string; tw: string; native: string; twSpellings: string[] }
const ROWS: Row[] = [
  { name: "Brand/600", hexes: ["#5B5FC7", "#112233"], css: "--Brand-600", tw: "--color-figma-brand-600", native: "brand600",
    twSpellings: ["bg-figma-brand-600", "text-figma-brand-600/80", "hover:border-figma-brand-600", "bg-(--color-figma-brand-600)", "var(--color-figma-brand-600)", "figma-brand-600"] },
  { name: "Schemes/On Primary", hexes: ["#FFFFFF", "#1B1B21"], css: "--Schemes-On-Primary", tw: "--color-figma-schemes-on-primary", native: "schemesOnPrimary",
    twSpellings: ["text-figma-schemes-on-primary", "fill-figma-schemes-on-primary!"] },
  { name: "Space 4 (24)", hexes: [], css: "--Space-4-e26d506e", tw: "--spacing-figma-space-4-e26d506e", native: "space4_e26d506e",
    twSpellings: ["p-figma-space-4-e26d506e", "gap-figma-space-4-e26d506e", "gap-x-figma-space-4-e26d506e", "space-figma-space-4-e26d506e"] },
  { name: "Space 4 (16)", hexes: [], css: "--Space-4-f00dbabe", tw: "--spacing-figma-space-4-f00dbabe", native: "space4_f00dbabe",
    twSpellings: ["px-figma-space-4-f00dbabe", "gap-y-figma-space-4-f00dbabe"] },
  { name: "Radius/XL", hexes: [], css: "--Radius-XL", tw: "--radius-figma-radius-xl", native: "radiusXL", twSpellings: ["rounded-figma-radius-xl"] },
  { name: "Type/Body Size", hexes: [], css: "--Type-Body-Size", tw: "--text-figma-type-body-size", native: "typeBodySize", twSpellings: ["text-figma-type-body-size"] },
  { name: "Font/Body", hexes: [], css: "--Font-Body", tw: "--font-figma-font-body", native: "fontBody", twSpellings: ["font-figma-font-body"] },
  { name: "Opacity/Disabled", hexes: [], css: "--Opacity-Disabled", tw: "--figma-opacity-disabled", native: "opacityDisabled", twSpellings: ["var(--figma-opacity-disabled)"] },
];
const cssSpellings = (r: Row): string[] => [r.css, `var(${r.css})`, `var(${r.css}, #000)`];
// a native token is read through its collection's type / instance / theme extension: the member is the token
const nativeSpellings = (r: Row): string[] => [r.native, `ColorsTokens.${r.native}`, `LocalColorsTokens.current.${r.native}`,
  `Theme.of(context).extension<ColorsTokens>()!.${r.native}`, `colorsTokens.light.${r.native}`, `SpacingTokens.${r.native}`];

const tokensCss = toCSS(ds);
const themeCss = must(toTailwind(ds)).text;
const NATIVE = { swiftui: toNative(ds, "swiftui"), compose: toNative(ds, "compose"), flutter: toNative(ds, "flutter"), "react-native": toNative(ds, "react-native") };
function must<T>(x: T | undefined): T { if (x === undefined) throw new Error("toTailwind returned nothing"); return x; }
const declared = (text: string): Set<string> => new Set([...text.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1] ?? ""));

console.log("round trip — the table above is what the emitters write:");
check("[css] tokens.css declares exactly the table's names", JSON.stringify([...declared(tokensCss)].sort()) === JSON.stringify(ROWS.map((r) => r.css).sort()));
check("[tailwind] theme.css declares exactly the table's names", JSON.stringify([...declared(themeCss)].sort()) === JSON.stringify(ROWS.map((r) => r.tw).sort()));
for (const [platform, out] of Object.entries(NATIVE)) {
  check(`[native] ${platform} declares every table identifier`, ROWS.every((r) => new RegExp(`\\b${r.native}\\b\\s*[:=]`).test(out.text)));
}

console.log("round trip — every emitted name is recognised under every builder spelling:");
for (const r of ROWS) {
  check(`[css] ${r.css} is the definition of ${cssSpellings(r).join(" | ")}`, cssSpellings(r).every((s) => namesToken(r.css, s, { stylesheet: true })));
  check(`[tailwind] ${r.tw} is the definition of ${r.twSpellings.join(" | ")}`, r.twSpellings.every((s) => namesToken(r.tw, s, { stylesheet: true })));
  check(`[native] ${r.native} is the definition of its qualified references`, nativeSpellings(r).every((s) => namesToken(r.native, s, { stylesheet: false })));
}
// A colliding variable's key tag is stripped from both sides on every target, so the tagged definition counts for the
// name it was disambiguated from — as it always did on the web (`-<tag>`), now in native code too (`_<tag>`).
check("[key] a key-tagged definition is the definition of its untagged name, on the web and in native code",
  namesToken("--spacing-figma-space-4-e26d506e", "p-figma-space-4", { stylesheet: true }) && namesToken("--Space-4-e26d506e", "var(--Space-4)", { stylesheet: true })
  && namesToken("space4_e26d506e", "SpacingTokens.space4", { stylesheet: false }));
check("[tailwind] a colour utility needs exactly the custom property theme.css declares", (() => {
  const have = new Set([...declared(themeCss)].map((n) => n.toLowerCase()));
  return ROWS.filter((r) => r.hexes.length).every((r) => r.twSpellings.every((s) => requiredCustomProps(s).every((p) => have.has(p))));
})());
check("[css] var(--x) needs --x, which tokens.css declares", (() => {
  const have = new Set([...declared(tokensCss)].map((n) => n.toLowerCase()));
  return ROWS.every((r) => requiredCustomProps(`var(${r.css})`).every((p) => have.has(p)) && requiredCustomProps(`var(${r.css})`).length === 1);
})());

// The gate's own path: the emitted file is in files[], each of its colour literals is on a line that defines the token
// the plan names — so none of them is a usage.
console.log("round trip — the emitted files' colour lines are definitions, not usages:");
const files: Array<{ rel: string; text: string; spell: (r: Row) => string[] }> = [
  { rel: "tokens.css", text: tokensCss, spell: cssSpellings },
  { rel: "theme.css", text: themeCss, spell: (r) => r.twSpellings },
  { rel: "DesignTokens.kt", text: NATIVE.compose.text, spell: nativeSpellings },
  { rel: "design_tokens.dart", text: NATIVE.flutter.text, spell: nativeSpellings },
  { rel: "designTokens.ts", text: NATIVE["react-native"].text, spell: nativeSpellings },
];
for (const f of files) {
  const code = [{ rel: f.rel, text: scanText(f.rel, f.text) }];
  const lits = colorLiterals(code[0]?.text ?? "");
  const ok = ROWS.filter((r) => r.hexes.length).every((r) => r.hexes.every((hex) => {
    const lit = lits.get(colorKey(hex) ?? "");
    return lit !== undefined && f.spell(r).every((s) => { const u = literalUses(code, lit, [s]); return u.found && !u.usedIn.length; });
  }));
  check(`[${f.rel}] every colour literal sits on its own token's definition line, under every spelling`, ok);
}

console.log("near misses are not definitions:");
check("[near] another token's name", !namesToken("--color-figma-brand-600", "brand-601", { stylesheet: true }) && !namesToken("--color-figma-brand-600", "bg-figma-brand-60", { stylesheet: true }));
check("[near] a prefix or an extension of the name", !namesToken("--color-figma-brand-600", "brand", { stylesheet: true }) && !namesToken("--color-figma-brand", "brand-600", { stylesheet: true })
  && !namesToken("--color-figma-brand-600", "figma-brand-600-hover", { stylesheet: true }));
check("[near] a CSS property is never a token's definition in a stylesheet", !namesToken("color", "brand-600", { stylesheet: true }) && !namesToken("brand600", "brand600", { stylesheet: true }));
check("[near] a key-tagged name is not a different number's", !namesToken("--spacing-figma-space-4-e26d506e", "space-40", { stylesheet: true })
  && !namesToken("--spacing-figma-space-4", "gap-y-figma-space-40", { stylesheet: true }));
check("[near] a tag that is not 8 hex digits is part of the name", !namesToken("--spacing-figma-space-4-headline", "space-4", { stylesheet: true })
  && !namesToken("space4_e26d506", "space4", { stylesheet: false }));
check("[near] a qualified native reference names its LAST member only", !namesToken("brand600", "ColorsTokens.brand6", { stylesheet: false })
  && !namesToken("colorsTokens", "colorsTokens.light.brand600", { stylesheet: false }) && !namesToken("light", "colorsTokens.light.brand600", { stylesheet: false }));
check("[near] a member that is a styling property is never a definition by the member rule — a component's own colour argument stays a use",
  (() => {
    const obj = literalUses([{ rel: "Card.tsx", text: "const styles = {\n  title: {\n    color: \"#5B5FC7\",\n  },\n};" }], "#5B5FC7", ["ColorsTokens.color"]);
    const compose = literalUses([{ rel: "Card.kt", text: "Text(\"Hi\", color = Color(0xFF5B5FC7))" }], "0xFF5B5FC7", ["LocalColorsTokens.current.color"]);
    const swift = literalUses([{ rel: "Card.tsx", text: "<Icon tintColor: \"#5B5FC7\" />" }], "#5B5FC7", ["theme.colors.tintColor"]);
    return obj.usedIn.join() === "Card.tsx" && compose.usedIn.join() === "Card.kt" && swift.usedIn.join() === "Card.tsx"
      && !namesToken("background", "AppTheme.background", { stylesheet: false }) && !namesToken("fill", "tokens.fill", { stylesheet: false });
  })());
check("[member] a Material colour-scheme slot is still its definition (`primary = Color(…)` for colorScheme.primary)",
  literalUses([{ rel: "Theme.kt", text: "val Light = lightColorScheme(\n  primary = Color(0xFF5B5FC7),\n)" }], "0xFF5B5FC7", ["MaterialTheme.colorScheme.primary"]).usedIn.length === 0);
check("[member] a comma-separated list of qualified references names each member",
  namesToken("brand600", "ColorsTokens.brand600, ColorsTokens.accent", { stylesheet: false }) && namesToken("accent", "ColorsTokens.brand600,ColorsTokens.accent", { stylesheet: false }));
check("[near] a decimal in a utility is not a member reference", !namesToken("5", "p-1.5", { stylesheet: false }));
check("[near] a line with a definition AND a usage of the literal is not a definition line", (() => {
  const code = [{ rel: "theme.css", text: ":root { --color-figma-brand-600: #5b5fc7; } .x { color: #5b5fc7 }" }];
  const u = literalUses(code, "#5b5fc7", ["bg-figma-brand-600"]);
  return u.found && u.usedIn.join() === "theme.css";
})());

report();
