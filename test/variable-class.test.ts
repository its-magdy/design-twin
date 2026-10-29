// test/variable-class.test.ts — what a Figma variable is (design-to-code/variable-class.ts classifyVariable): one table of
// variable → class, scopes first and the name only under ALL_SCOPES, with the one precedence rule (radius before font
// size) on the conflicts; then the emitters agreeing on it — Tailwind's namespace, DTCG's $type and native's sp/dp all
// read the same class.
// Run with:  bun test/variable-class.test.ts
import { classifyVariable, isSentinel, type VariableClass } from "../design-to-code/variable-class.ts";
import { toDTCG, toTailwind } from "../design-to-code/tokens.ts";
import { toNative } from "../design-to-code/tokens-native.ts";
import type { VariableType } from "../design-to-code/types.ts";
import { tokens, variable } from "./fixtures.ts";
import { check, report } from "./assert.ts";

interface Row { why: string; type: VariableType; name: string; collection?: string; scopes?: string[]; unitless?: boolean; want: VariableClass | null }
const ROWS: Row[] = [
  // by type
  { why: "a COLOR", type: "COLOR", name: "Brand/600", want: "color" },
  { why: "a BOOLEAN", type: "BOOLEAN", name: "Flags/On", want: "bool" },
  { why: "an EASING (a motion object, no emitter writes it)", type: "EASING", name: "Motion/Ease", want: null },
  { why: "a TIMING", type: "TIMING", name: "Motion/Fast", want: null },
  // STRING: FONT_FAMILY scope, else the name under ALL_SCOPES
  { why: "a FONT_FAMILY-scoped STRING, whatever its name", type: "STRING", name: "Heading", collection: "Type", scopes: ["FONT_FAMILY"], want: "fontFamily" },
  { why: "a STRING narrowed to FONT_STYLE is not a family, even named one", type: "STRING", name: "font-family/style", scopes: ["FONT_STYLE"], want: "string" },
  { why: "an ALL_SCOPES STRING named font-family", type: "STRING", name: "Font Family/Body", scopes: ["ALL_SCOPES"], want: "fontFamily" },
  { why: "an unscoped STRING in a Typeface collection", type: "STRING", name: "Body", collection: "Typeface", want: "fontFamily" },
  { why: "a plain STRING", type: "STRING", name: "Label/Submit", want: "string" },
  // FLOAT: the unit first
  { why: "an OPACITY-scoped FLOAT is a percentage", type: "FLOAT", name: "Disabled", scopes: ["OPACITY"], want: "percent" },
  { why: "a COLOR_OPACITY-scoped FLOAT is a percentage", type: "FLOAT", name: "Overlay", scopes: ["COLOR_OPACITY"], want: "percent" },
  { why: "OPACITY + FONT_WEIGHT is unitless but no percentage (which half is it?)", type: "FLOAT", name: "Mixed", scopes: ["OPACITY", "FONT_WEIGHT"], want: "number" },
  { why: "a FONT_WEIGHT-scoped FLOAT", type: "FLOAT", name: "Bold", scopes: ["FONT_WEIGHT"], want: "number" },
  { why: "an ALL_SCOPES FLOAT named opacity is unitless, not a percentage (no evidence of Figma's scale)", type: "FLOAT", name: "Opacity/Disabled", scopes: ["ALL_SCOPES"], want: "number" },
  { why: "an unscoped FLOAT named font-weight", type: "FLOAT", name: "text/font-weight", want: "number" },
  { why: "a font-weight-scale is a multiplier name, so a length", type: "FLOAT", name: "font-weight-scale/lg", want: "length" },
  { why: "a name the caller declared unitless", type: "FLOAT", name: "Space/4", unitless: true, want: "number" },
  { why: "a declared-unitless OPACITY FLOAT stays a bare number", type: "FLOAT", name: "Fade", scopes: ["OPACITY"], unitless: true, want: "number" },
  { why: "a unitless scope beside a length scope does not win", type: "FLOAT", name: "Body", scopes: ["FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT"], want: "fontSize" },
  { why: "narrowed scopes beat an opacity name", type: "FLOAT", name: "Opacity/Gap", scopes: ["GAP"], want: "length" },
  // FLOAT lengths: scopes first
  { why: "a CORNER_RADIUS-scoped FLOAT", type: "FLOAT", name: "XL", scopes: ["CORNER_RADIUS"], want: "radius" },
  { why: "a FONT_SIZE-scoped FLOAT", type: "FLOAT", name: "Body", scopes: ["FONT_SIZE"], want: "fontSize" },
  { why: "a GAP-scoped FLOAT", type: "FLOAT", name: "Space/4", scopes: ["GAP", "WIDTH_HEIGHT"], want: "length" },
  { why: "ALL_SCOPES beside CORNER_RADIUS still counts as narrowed", type: "FLOAT", name: "Space/4", scopes: ["ALL_SCOPES", "CORNER_RADIUS"], want: "radius" },
  { why: "narrowed scopes beat a radius name", type: "FLOAT", name: "Radius/Gap", scopes: ["GAP"], want: "length" },
  { why: "narrowed scopes beat a font-size name", type: "FLOAT", name: "Font Size/Gap", scopes: ["WIDTH_HEIGHT"], want: "length" },
  // the conflicts: radius before font size, in scopes and in names alike
  { why: "CONFLICT: scoped CORNER_RADIUS + FONT_SIZE is a radius", type: "FLOAT", name: "Shared", scopes: ["CORNER_RADIUS", "FONT_SIZE"], want: "radius" },
  { why: "CONFLICT: scope order does not matter", type: "FLOAT", name: "Shared", scopes: ["FONT_SIZE", "CORNER_RADIUS"], want: "radius" },
  { why: "CONFLICT: a name reading both ways is a radius", type: "FLOAT", name: "font-size/rounded", want: "radius" },
  { why: "CONFLICT: a radius name in a Type Size collection is a radius", type: "FLOAT", name: "radius/md", collection: "Type Size", scopes: ["ALL_SCOPES"], want: "radius" },
  // FLOAT lengths: the name under ALL_SCOPES
  { why: "an unscoped FLOAT named radius", type: "FLOAT", name: "Radius/XL", want: "radius" },
  { why: "an unscoped FLOAT named corner", type: "FLOAT", name: "corner/sm", want: "radius" },
  { why: "an unscoped FLOAT named rounded", type: "FLOAT", name: "Rounded/Full", want: "radius" },
  { why: "the radius name is the variable's, not its collection's", type: "FLOAT", name: "full", collection: "Radius", want: "length" },
  { why: "an unscoped FLOAT named font-size", type: "FLOAT", name: "font-size/body", want: "fontSize" },
  { why: "a text_size name", type: "FLOAT", name: "text_size/sm", want: "fontSize" },
  { why: "a Type Size collection's FLOAT", type: "FLOAT", name: "Body", collection: "Type Size", scopes: ["ALL_SCOPES"], want: "fontSize" },
  { why: "a plain FLOAT is a length", type: "FLOAT", name: "Space/4", want: "length" },
  { why: "'background' does not read as rounded", type: "FLOAT", name: "background/offset", want: "length" },
];

console.log("variable → class:");
const unitless = { unitless: new Set(ROWS.filter((r) => r.unitless).map((r) => r.name)) };
for (const r of ROWS) {
  const v = variable({ name: r.name, type: r.type, collection: r.collection ?? "Tokens", values: { Mode: r.type === "STRING" ? "Inter" : r.type === "COLOR" ? "#112233" : 8 }, ...(r.scopes ? { scopes: r.scopes } : {}) });
  const got = classifyVariable(v, r.unitless ? unitless : undefined);
  check(`[class] ${r.why}: ${r.name}${r.scopes ? ` [${r.scopes.join(", ")}]` : ""} → ${String(r.want)}${got === r.want ? "" : ` (got ${String(got)})`}`, got === r.want);
}

console.log("\nthe fully-rounded sentinel — a value test, its guard wider than the radius class:");
const f = (name: string, scopes?: string[], collection = "Tokens") => variable({ name, type: "FLOAT", collection, values: { Mode: 1e9 }, ...(scopes ? { scopes } : {}) });
check("[sentinel] a radius at 1e9", isSentinel(f("Radius/Full"), 1e9));
check("[sentinel] a scoped CORNER_RADIUS + FONT_SIZE at 1e9 (a radius)", isSentinel(f("Shared", ["CORNER_RADIUS", "FONT_SIZE"]), 1e9));
check("[sentinel] an unscoped token in a Radius collection — not a radius class, still caught", isSentinel(f("full", undefined, "Radius"), 1e9) && classifyVariable(f("full", undefined, "Radius")) === "length");
check("[sentinel] a FONT_SIZE-scoped 1e9 is no radius", !isSentinel(f("Huge", ["FONT_SIZE"]), 1e9));
check("[sentinel] a radius below the threshold is no sentinel", !isSentinel(f("Radius/Full"), 9999));

// ---------------------------------------------------------------- every emitter reads the same class
console.log("\nthe emitters agree on the class:");
const lengthRows = ROWS.filter((r) => r.type === "FLOAT" && !r.unitless);
const ds = tokens({
  collections: [{ name: "Tokens", modes: ["Mode"], default: "Mode" }, { name: "Type Size", modes: ["Mode"], default: "Mode" }, { name: "Radius", modes: ["Mode"], default: "Mode" }],
  variables: lengthRows.map((r, i) => ({ name: `${r.name}/r${i}`, type: r.type, collection: r.collection ?? "Tokens", key: `key${i}`, values: { Mode: 8 }, ...(r.scopes ? { scopes: r.scopes } : {}) })),
});
const tw = toTailwind(ds).text;
const compose = toNative(ds, "compose").text;
const dtcg = JSON.stringify(toDTCG(ds));
const NS: Partial<Record<VariableClass, string>> = { radius: "--radius-figma-", fontSize: "--text-figma-", length: "--spacing-figma-" };
const KT: Partial<Record<VariableClass, string>> = { radius: "Dp", fontSize: "TextUnit", length: "Dp", percent: "Float", number: "Float" };
lengthRows.forEach((r, i) => {
  const source = `${r.name}/r${i}`;
  const twLine = tw.split("\n").find((l) => l.includes(`-r${i}:`)) ?? "";
  const ns = NS[r.want ?? "number"];
  const twOk = ns ? twLine.trimStart().startsWith(ns) : twLine.trimStart().startsWith("--figma-");
  const kt = new RegExp(`val \\w+: (\\w+) = .* // ${source.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m").exec(compose)?.[1];
  check(`[agree] ${r.why}: theme.css ${ns ?? "--figma-"}… and Compose ${KT[r.want ?? "number"]}`, twOk && kt === KT[r.want ?? "number"]);
});
check("[agree] DTCG: a radius / font size / length is a dimension, a percentage or number is not",
  (dtcg.match(/"\$type":"dimension"/g) ?? []).length === lengthRows.filter((r) => r.want === "radius" || r.want === "fontSize" || r.want === "length").length);

// The emitted-output change this module made, pinned: native used to ask only FONT_SIZE (so a FLOAT scoped to
// CORNER_RADIUS + FONT_SIZE was a font size in sp) while theme.css filed it under --radius-*. Now both say radius.
console.log("\nthe CORNER_RADIUS + FONT_SIZE conflict, end to end:");
const conflict = tokens({
  collections: [{ name: "Tokens", modes: ["Mode"], default: "Mode" }],
  variables: [{ name: "Shared", type: "FLOAT", collection: "Tokens", scopes: ["CORNER_RADIUS", "FONT_SIZE"], values: { Mode: 12 } },
    { name: "Pill", type: "FLOAT", collection: "Tokens", scopes: ["FONT_SIZE", "CORNER_RADIUS"], values: { Mode: 1e9 } }],
});
const cc = toNative(conflict, "compose").text;
check("[conflict] theme.css files it under --radius-*", toTailwind(conflict).text.includes("--radius-figma-shared: 12px;"));
check("[conflict] Compose writes a Dp, not a TextUnit (sp)", cc.includes("val shared: Dp = 12.dp") && !cc.includes(": TextUnit"));
check("[conflict] a fully-rounded one is Compose's 9999.dp CircleShape idiom, not 9999.sp", cc.includes("val pill: Dp = 9999.dp /* Figma 'fully rounded' — use CircleShape */"));

report();
