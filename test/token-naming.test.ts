// test/token-naming.test.ts — the names a Figma variable gets on every target (design-to-code/token-naming.ts), and the
// round trip the Stop hook depends on: every name the emitters actually write (tokens.css, theme.css, the four native
// files) is recognised by the gate as that token's definition when the plan names it the way a builder writes it — and a
// near miss is not.
// Run with:  bun test/token-naming.test.ts
import { toCSS, toTailwind } from "../design-to-code/tokens.ts";
import { toNative } from "../design-to-code/tokens-native.ts";
import { TW_PREFIX, cssVarName, disambiguated, keyTag, namesToken, nativeIdentifier, requiredCustomProps, tailwindVarName } from "../design-to-code/token-naming.ts";
import { colorLiterals, enclosingHeads, isDefinitionAt, literalUses, scanText } from "../design-to-code/code-scanner.ts";
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
// One design system with every naming path in it: a two-mode colour, a name with a space, two different colours and two
// different spacings sharing a name (each emitted with its key tag), a single-mode colour collection, a radius, a font
// size, a font family and a unitless opacity.
const ds = tokens({
  collections: [{ name: "Colors", modes: ["Light", "Dark"], default: "Light" }, { name: "Spacing", modes: ["Mode 1"], default: "Mode 1" },
    { name: "Brand Palette", modes: ["Mode 1"], default: "Mode 1" }],
  variables: [
    { name: "Brand/600", type: "COLOR", collection: "Colors", key: "aaaa1111bbbb", values: { Light: "#5B5FC7", Dark: "#112233" } },
    { name: "Schemes/On Primary", type: "COLOR", collection: "Colors", key: "bbbb2222cccc", values: { Light: "#FFFFFF", Dark: "#1B1B21" } },
    { name: "Accent", type: "COLOR", collection: "Colors", key: "cccc1111aaaa", values: { Light: "#FF3B30", Dark: "#FF453A" } },
    { name: "Accent", type: "COLOR", collection: "Colors", key: "dddd2222bbbb", values: { Light: "#34C759", Dark: "#30D158" } },
    { name: "Primary", type: "COLOR", collection: "Brand Palette", key: "eeee3333cccc", values: { "Mode 1": "#0A84FF" } },
    { name: "Space 4", type: "FLOAT", collection: "Spacing", key: "e26d506eaaaa", values: { "Mode 1": 24 } },
    { name: "Space 4", type: "FLOAT", collection: "Spacing", key: "f00dbabe1111", values: { "Mode 1": 16 } },
    { name: "Radius/XL", type: "FLOAT", collection: "Spacing", key: "cccc3333dddd", scopes: ["CORNER_RADIUS"], values: { "Mode 1": 12 } },
    { name: "Type/Body Size", type: "FLOAT", collection: "Spacing", key: "dddd4444eeee", scopes: ["FONT_SIZE"], values: { "Mode 1": 14 } },
    { name: "Font/Body", type: "STRING", collection: "Spacing", key: "eeee5555ffff", scopes: ["FONT_FAMILY"], values: { "Mode 1": "Inter" } },
    { name: "Opacity/Disabled", type: "FLOAT", collection: "Spacing", key: "ffff6666aaaa", scopes: ["OPACITY"], values: { "Mode 1": 40 } },
  ],
});

// What each variable is called on each target, and how a builder spells it in a plan's codeToken there.
type Collection = "colors" | "spacing" | "brand";
interface Row { name: string; coll: Collection; hexes: string[]; css: string; tw: string; native: string; twSpellings: string[] }
const ROWS: Row[] = [
  { name: "Brand/600", coll: "colors", hexes: ["#5B5FC7", "#112233"], css: "--Brand-600", tw: "--color-figma-brand-600", native: "brand600",
    twSpellings: ["bg-figma-brand-600", "text-figma-brand-600/80", "hover:border-figma-brand-600", "bg-(--color-figma-brand-600)", "var(--color-figma-brand-600)", "figma-brand-600"] },
  { name: "Schemes/On Primary", coll: "colors", hexes: ["#FFFFFF", "#1B1B21"], css: "--Schemes-On-Primary", tw: "--color-figma-schemes-on-primary", native: "schemesOnPrimary",
    twSpellings: ["text-figma-schemes-on-primary", "fill-figma-schemes-on-primary!"] },
  { name: "Accent (red)", coll: "colors", hexes: ["#FF3B30", "#FF453A"], css: "--Accent-cccc1111", tw: "--color-figma-accent-cccc1111", native: "accent_cccc1111",
    twSpellings: ["bg-figma-accent-cccc1111", "text-figma-accent-cccc1111"] },
  { name: "Accent (green)", coll: "colors", hexes: ["#34C759", "#30D158"], css: "--Accent-dddd2222", tw: "--color-figma-accent-dddd2222", native: "accent_dddd2222",
    twSpellings: ["border-figma-accent-dddd2222"] },
  { name: "Primary", coll: "brand", hexes: ["#0A84FF"], css: "--Primary", tw: "--color-figma-primary", native: "primary", twSpellings: ["bg-figma-primary", "ring-figma-primary"] },
  { name: "Space 4 (24)", coll: "spacing", hexes: [], css: "--Space-4-e26d506e", tw: "--spacing-figma-space-4-e26d506e", native: "space4_e26d506e",
    twSpellings: ["p-figma-space-4-e26d506e", "gap-figma-space-4-e26d506e", "gap-x-figma-space-4-e26d506e", "space-figma-space-4-e26d506e"] },
  { name: "Space 4 (16)", coll: "spacing", hexes: [], css: "--Space-4-f00dbabe", tw: "--spacing-figma-space-4-f00dbabe", native: "space4_f00dbabe",
    twSpellings: ["px-figma-space-4-f00dbabe", "gap-y-figma-space-4-f00dbabe"] },
  { name: "Radius/XL", coll: "spacing", hexes: [], css: "--Radius-XL", tw: "--radius-figma-radius-xl", native: "radiusXL", twSpellings: ["rounded-figma-radius-xl"] },
  { name: "Type/Body Size", coll: "spacing", hexes: [], css: "--Type-Body-Size", tw: "--text-figma-type-body-size", native: "typeBodySize", twSpellings: ["text-figma-type-body-size"] },
  { name: "Font/Body", coll: "spacing", hexes: [], css: "--Font-Body", tw: "--font-figma-font-body", native: "fontBody", twSpellings: ["font-figma-font-body"] },
  { name: "Opacity/Disabled", coll: "spacing", hexes: [], css: "--Opacity-Disabled", tw: "--figma-opacity-disabled", native: "opacityDisabled", twSpellings: ["var(--figma-opacity-disabled)"] },
];
const cssSpellings = (r: Row): string[] => [r.css, `var(${r.css})`, `var(${r.css}, #000)`];
// A native token is read through what its platform's file declares for its collection — the collection's type,
// instance or theme extension; the member is the token. Each platform's own reading paths, per collection. `modes`:
// a single mode's instance (Compose's `ColorsTokensLight`), which defines only that mode's values.
type Platform = "swiftui" | "compose" | "flutter" | "react-native";
const NATIVE_PATHS: Record<Platform, Record<Collection, string[]> & { modes: string[] }> = {
  swiftui: { colors: ["ColorsTokens.light"], spacing: ["SpacingTokens"], brand: ["BrandPaletteTokens"], modes: [] },
  compose: { colors: ["LocalColorsTokens.current"], spacing: ["SpacingTokens"], brand: ["BrandPaletteTokens"], modes: ["ColorsTokensLight"] },
  flutter: { colors: ["Theme.of(context).extension<ColorsTokens>()!", "ColorsTokens.light"], spacing: ["SpacingTokens"], brand: ["BrandPaletteTokens"], modes: [] },
  "react-native": { colors: ["colorsTokens.light"], spacing: ["spacingTokens"], brand: ["brandPaletteTokens"], modes: [] },
};
const nativeSpellingsOf = (platform: Platform) => (r: Row): string[] => [r.native, ...NATIVE_PATHS[platform][r.coll].map((p) => `${p}.${r.native}`)];
// …and, for the declaration round trip (where any one declaration of the member counts), the mode instances too
const nativeDeclSpellingsOf = (platform: Platform) => (r: Row): string[] =>
  [...nativeSpellingsOf(platform)(r), ...(r.coll === "colors" ? NATIVE_PATHS[platform].modes.map((p) => `${p}.${r.native}`) : [])];

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
  for (const platform of ["swiftui", "compose", "flutter", "react-native"] satisfies Platform[]) {
    const spell = nativeDeclSpellingsOf(platform)(r);
    // through the gate's own reading of the generated file: some declaration of the identifier there defines the token
    const file = { rel: NATIVE[platform].file, text: NATIVE[platform].text };
    const values = [...file.text.matchAll(new RegExp(`\\b${r.native}\\b\\s*[:=]\\s*`, "g"))].map((m) => (m.index ?? 0) + m[0].length);
    check(`[native/${platform}] ${r.native} in the generated file is the definition of ${spell.slice(1).join(" | ")}`,
      values.length > 0 && spell.every((s) => values.some((at) => isDefinitionAt(file, at, s))));
  }
}
// A colliding variable's key tag is stripped from both sides on every target, so the tagged definition counts for the
// name it was disambiguated from — as it always did on the web (`-<tag>`), now in native code too (`_<tag>`).
check("[key] a key-tagged definition is the definition of its untagged name, on the web and in native code",
  namesToken("--spacing-figma-space-4-e26d506e", "p-figma-space-4", { stylesheet: true }) && namesToken("--Space-4-e26d506e", "var(--Space-4)", { stylesheet: true })
  && namesToken("space4_e26d506e", "SpacingTokens.space4", { stylesheet: false, enclosing: () => ["object SpacingTokens "] }));
check("[tailwind] a colour utility needs exactly the custom property theme.css declares", (() => {
  const have = new Set([...declared(themeCss)].map((n) => n.toLowerCase()));
  return ROWS.filter((r) => r.hexes.length).every((r) => r.twSpellings.every((s) => requiredCustomProps(s).every((p) => have.has(p))));
})());
check("[css] var(--x) needs --x, which tokens.css declares", (() => {
  const have = new Set([...declared(tokensCss)].map((n) => n.toLowerCase()));
  return ROWS.every((r) => requiredCustomProps(`var(${r.css})`).every((p) => have.has(p)) && requiredCustomProps(`var(${r.css})`).length === 1);
})());

// The gate's own path: the emitted file is in files[], each of its colour literals is on a line that defines the token
// the plan names — so none of them is a usage. (SwiftUI is not in this loop: it writes a colour as `Color(.sRGB, red: …)`,
// which holds no hex literal for the gate to find.)
console.log("round trip — the emitted files' colour lines are definitions, not usages:");
const files: Array<{ rel: string; text: string; spell: (r: Row) => string[] }> = [
  { rel: "tokens.css", text: tokensCss, spell: cssSpellings },
  { rel: "theme.css", text: themeCss, spell: (r) => r.twSpellings },
  { rel: "DesignTokens.kt", text: NATIVE.compose.text, spell: nativeSpellingsOf("compose") },
  { rel: "design_tokens.dart", text: NATIVE.flutter.text, spell: nativeSpellingsOf("flutter") },
  { rel: "designTokens.ts", text: NATIVE["react-native"].text, spell: nativeSpellingsOf("react-native") },
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
const IN_TOKENS = (): string[] => ["object ColorsTokens "];
check("[near] a qualified native reference names its LAST member only", !namesToken("brand600", "ColorsTokens.brand6", { stylesheet: false, enclosing: IN_TOKENS })
  && !namesToken("ColorsTokens", "ColorsTokens.brand600", { stylesheet: false, enclosing: IN_TOKENS }) && !namesToken("light", "colorsTokens.light.brand600", { stylesheet: false, enclosing: () => ["export const colorsTokens = "] }));
check("[member] a member counts only inside a block that names the reference's container", namesToken("brand600", "ColorsTokens.brand600", { stylesheet: false, enclosing: IN_TOKENS })
  && !namesToken("brand600", "ColorsTokens.brand600", { stylesheet: false, enclosing: () => ["fun Card() ", "  Column("] }) && !namesToken("brand600", "ColorsTokens.brand600", { stylesheet: false })
  // a path word or a call argument is not a container: a block named `light` or `context` does not count
  && !namesToken("brand600", "Theme.of(context).extension<ColorsTokens>()!.brand600", { stylesheet: false, enclosing: () => ["val context = "] })
  && !namesToken("brand600", "colorsTokens.light.brand600", { stylesheet: false, enclosing: () => ["const light = "] }));
check("[enclosing] the heads of the blocks around a position, outermost first; a closed block is not around it", (() => {
  const text = "object ColorsTokens {\n  val a = Color(0xFF000000)\n}\nfun Card() {\n  Text(color = Color(0xFF5B5FC7))\n}";
  const around = enclosingHeads(text, text.indexOf("0xFF5B5FC7"));
  return JSON.stringify(around) === JSON.stringify(["fun Card() ", "  Text", "  Text(color = Color"]) && enclosingHeads(text, text.indexOf("0xFF000000"))[0] === "object ColorsTokens ";
})());
// Review round 4: a block head only counts when it declares the container, constructs it, or initialises a binding of
// that name — a local OVERRIDE (`.copy(`, `.copyWith(`, `Partial<C> = {`, a style array) is a hand-picked colour.
check("[near] a local override of the token object is a use, not a definition", (() => {
  const use = (rel: string, text: string, lit: string, token: string): boolean => literalUses([{ rel, text }], lit, [token]).usedIn.join() === rel;
  return use("Card.kt", "val c = ColorsTokens.light.copy(\n  brand600 = Color(0xFF5B5FC7),\n)", "0xFF5B5FC7", "ColorsTokens.brand600")
    && use("card.dart", "final t = Theme.of(context).extension<ColorsTokens>()!.copyWith(\n  brand600: const Color(0xFF5B5FC7),\n);", "0xFF5B5FC7", "Theme.of(context).extension<ColorsTokens>()!.brand600")
    && use("Root.kt", "CompositionLocalProvider(LocalColorsTokens provides ColorsTokensLight.copy(\n  brand600 = Color(0xFF5B5FC7),\n)) {}", "0xFF5B5FC7", "LocalColorsTokens.current.brand600")
    && use("Theme.kt", "MaterialTheme(colorScheme = MaterialTheme.colorScheme.copy(\n  primary = Color(0xFF5B5FC7),\n)) {}", "0xFF5B5FC7", "MaterialTheme.colorScheme.primary")
    && use("Card.tsx", "const o: Partial<ColorsTokens> = {\n  brand600: \"#5B5FC7\",\n};", "#5B5FC7", "ColorsTokens.brand600")
    && use("Card.tsx", "<View style={[colorsTokens.card, {\n  brand600: \"#5B5FC7\" }]} />", "#5B5FC7", "colorsTokens.light.brand600");
})());
check("[near] a shorter type name is not the container: `Colors(` for AppColors, `Tokens` for colorsTokens", (() => {
  const use = (rel: string, text: string, lit: string, token: string): boolean => literalUses([{ rel, text }], lit, [token]).usedIn.join() === rel;
  return use("Card.kt", "val c = Colors(\n  primary = Color(0xFF5B5FC7),\n)", "0xFF5B5FC7", "AppColors.primary")
    && use("Card.tsx", "const s = makeStyles((Tokens) => ({\n  brand600: \"#5B5FC7\",\n}));", "#5B5FC7", "colorsTokens.light.brand600");
})());
check("[enclosing] a bracket inside a string does not open a block: the token object closes where it ends", (() => {
  const text = "object ColorsTokens {\n  val sep = \"(\"\n}\nfun Card() {\n  val brand600 = Color(0xFF5B5FC7)\n}";
  return literalUses([{ rel: "Card.kt", text }], "0xFF5B5FC7", ["ColorsTokens.brand600"]).usedIn.join() === "Card.kt"
    && JSON.stringify(enclosingHeads(text, text.indexOf("0xFF5B5FC7")).slice(0, 1)) === JSON.stringify(["fun Card() "]);
})());
// Review round 5: a construction counts only into a binding (not a named argument or a default parameter); a head's
// string contents are not code; a multi-line string's brackets are not blocks.
check("[near] constructing the container as an argument or a default is a use, not a definition", (() => {
  const use = (rel: string, text: string): boolean => literalUses([{ rel, text }], "0xFF5B5FC7", ["ColorsTokens.brand600"]).usedIn.join() === rel;
  return use("Card.kt", "Card(colors = ColorsTokens(\n  brand600 = Color(0xFF5B5FC7)))")
    && use("Card.kt", "fun Card(t: ColorsTokens = ColorsTokens(\n  brand600 = Color(0xFF5B5FC7))) {}")
    && use("Card.kt", "Box(Modifier.testTag(\"object ColorsTokens\")) {\n  val brand600 = Color(0xFF5B5FC7)\n}");
})());
check("[enclosing] a bracket inside a multi-line string (\"\"\" or ''') does not open a block", (() => {
  const kt = "object ColorsTokens {\n  val doc = \"\"\"\n  a { b\n  \"\"\"\n}\nfun Card() {\n  val brand600 = Color(0xFF5B5FC7)\n}";
  const dart = "class ColorsTokens {\n  static const doc = '''\n  a { b\n  ''';\n}\nWidget card() {\n  const brand600 = Color(0xFF5B5FC7);\n}";
  return literalUses([{ rel: "Card.kt", text: kt }], "0xFF5B5FC7", ["ColorsTokens.brand600"]).usedIn.join() === "Card.kt"
    && literalUses([{ rel: "card.dart", text: dart }], "0xFF5B5FC7", ["ColorsTokens.brand600"]).usedIn.join() === "card.dart";
})());
// Review round 6: a head is the opener's own statement, not the statements closed before it on the line.
check("[enclosing] a statement closed earlier on the opener's line is not part of its head", (() => {
  const ts = "class ColorsTokens { brand600 = \"#5B5FC7\"; } const styles = {\n  brand600: \"#5B5FC7\",\n};";
  const kt = "object ColorsTokens { val x = 1 }; fun Card() {\n  val brand600 = Color(0xFF5B5FC7)\n}";
  const kept = "class AppColors(x: Int) {\n  val primary = Color(0xFF5B5FC7)\n}";
  return literalUses([{ rel: "Card.tsx", text: ts }], "#5B5FC7", ["ColorsTokens.brand600"]).usedIn.join() === "Card.tsx"
    && literalUses([{ rel: "Card.kt", text: kt }], "0xFF5B5FC7", ["ColorsTokens.brand600"]).usedIn.join() === "Card.kt"
    && literalUses([{ rel: "AppColors.kt", text: kept }], "0xFF5B5FC7", ["AppColors.primary"]).usedIn.length === 0;
})());
// Review round 3: a component that binds a container's name (a local alias) is not the container's scope.
check("[near] a component-local alias of the container does not make the component's styles definitions", (() => {
  const text = "const colorsTokens = useColorsTokens();\nconst styles = {\n  backgroundImage: \"linear-gradient(#5B5FC7, transparent)\",\n  hero: colorsTokens.light.brand600,\n};";
  return literalUses([{ rel: "Card.tsx", text }], "#5B5FC7", ["colorsTokens.light.backgroundImage"]).usedIn.join() === "Card.tsx"
    && literalUses([{ rel: "Card.kt", text: "val ColorsTokens = LocalColorsTokens.current\nText(\"Hi\", tint = Color(0xFF5B5FC7))" }], "0xFF5B5FC7", ["ColorsTokens.tint"]).usedIn.join() === "Card.kt";
})());
// A generated token line and a component's styling argument are the same syntax; in a component (no container declared)
// the member rule never applies, whatever the member is called.
check("[near] a component's own styling argument stays a use, whatever member the codeToken ends in", (() => {
  const use = (rel: string, text: string, lit: string, token: string): boolean => literalUses([{ rel, text }], lit, [token]).usedIn.join() === rel;
  return use("Card.tsx", "const styles = {\n  title: {\n    color: \"#5B5FC7\",\n  },\n};", "#5B5FC7", "ColorsTokens.color")
    && use("Card.kt", "Text(\"Hi\", color = Color(0xFF5B5FC7))", "0xFF5B5FC7", "LocalColorsTokens.current.color")
    && use("Card.kt", "Text(\"Hi\", color = Color(0xFF5B5FC7))", "0xFF5B5FC7", "ColorsTokens.color_e26d506e")
    && use("Card.tsx", "const s = StyleSheet.create({\n  box: {\n    backgroundColor: \"#5B5FC7\",\n  },\n});", "#5B5FC7", "ColorsTokens.backgroundColor_e26d506e")
    && use("card.dart", "decoration: BoxDecoration(gradient: LinearGradient(\n  colors: [Color(0xFF5B5FC7), Colors.white],\n)),", "0xFF5B5FC7", "ColorsTokens.colors")
    && use("Card.tsx", "const s = {\n  hero: {\n    backgroundImage: \"linear-gradient(#5B5FC7, transparent)\",\n  },\n};", "#5B5FC7", "ColorsTokens.backgroundImage");
})());
check("[near] even in a token file, a styling-property member (key tag stripped) is refused — the bare name still works",
  !namesToken("color", "ColorsTokens.color", { stylesheet: false, enclosing: IN_TOKENS }) && !namesToken("color", "ColorsTokens.color_e26d506e", { stylesheet: false, enclosing: IN_TOKENS })
  && !namesToken("backgroundColor", "ColorsTokens.backgroundColor", { stylesheet: false, enclosing: IN_TOKENS }) && namesToken("color", "color", { stylesheet: false }));
check("[member] a hand-written token object is its own definition (`object AppColors { val primary = … }` for AppColors.primary)",
  literalUses([{ rel: "Theme.kt", text: "object AppColors {\n  val primary = Color(0xFF5B5FC7)\n}" }], "0xFF5B5FC7", ["AppColors.primary"]).usedIn.length === 0);
check("[member] a comma-separated list of qualified references names each member",
  namesToken("brand600", "ColorsTokens.brand600, ColorsTokens.accent", { stylesheet: false, enclosing: IN_TOKENS })
  && namesToken("accent", "ColorsTokens.brand600,ColorsTokens.accent", { stylesheet: false, enclosing: IN_TOKENS }));
check("[near] a decimal in a utility is not a member reference", !namesToken("5", "p-1.5", { stylesheet: false }));
check("[near] a line with a definition AND a usage of the literal is not a definition line", (() => {
  const code = [{ rel: "theme.css", text: ":root { --color-figma-brand-600: #5b5fc7; } .x { color: #5b5fc7 }" }];
  const u = literalUses(code, "#5b5fc7", ["bg-figma-brand-600"]);
  return u.found && u.usedIn.join() === "theme.css";
})());

report();
