// The screen outline (bridge/src/outline.ts): one line per node, repeated styles hoisted, a ladder that fits the
// limit, and no field or truncation note lost without saying so.
//   bun test/outline.test.ts
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { check, report } from "./assert.ts";
import { screenOutline } from "../bridge/src/outline.ts";
import type { OutlineSource } from "../bridge/src/outline.ts";
import type { IrNode, Manifest, ScreenExport } from "../bridge/src/doc-types.ts";

const more = (level: string): string => "more-for-" + level;
const LOTS = 1_000_000;
const full = (s: OutlineSource) => {
  const o = screenOutline(s, { limit: LOTS, more });
  if (!o) throw new Error("no outline");
  return o;
};
const manifest = (over: Partial<Manifest> = {}): Manifest => ({ nodes: 1, skipped: 0, truncated: 0, assetsFailed: 0, assetsSkipped: 0, assetsSkippedInvisible: 0, assetsGeometry: 0, warnings: [], ...over });
const source = (nodes: IrNode[], m?: Manifest): OutlineSource => ({ screen: { nodes, ...(m ? { manifest: m } : {}) } });
const lineOf = (text: string, id: string): string => text.split("\n").find((l) => l.includes("#" + id) && !l.startsWith("OUTLINE")) ?? "";

console.log("\nthe lines:");
{
  const text = full(source([{ type: "FRAME", name: "Card", id: "1:1", box: { w: 320, h: 200 }, layout: { display: "flex", flexDirection: "column", gap: 8, padding: [16, 16, 16, 16] }, children: [
    { type: "TEXT", name: "Hello", id: "1:2", text: "Hello", box: { w: 40, h: 20 } },
    { type: "RECTANGLE", name: "Rectangle 12", id: "1:3", box: { w: 10, h: 10 } },
    { type: "INSTANCE", name: "Nav", id: "1:4", props: { State: "On" }, component: "State=On", mainComponent: { name: "State=On", key: "abc", setName: "Nav" } },
  ] }])).text;
  check("a frame: type, name, id, size, layout", lineOf(text, "1:1") === "[FRAME] \"Card\" #1:1 320x200 col gap=8 p=16");
  check("children are indented under their parent", lineOf(text, "1:2").startsWith("  [TEXT]"));
  check("a TEXT named after its text drops the name", lineOf(text, "1:2") === "  [TEXT] #1:2 40x20 \"Hello\"");
  check("a default layer name is dropped", lineOf(text, "1:3") === "  [RECTANGLE] #1:3 10x10");
  check("an instance: → its component with the join key, its props; `component` not said twice",
    lineOf(text, "1:4").includes("→ {name:\"State=On\",key:abc,setName:Nav}") && lineOf(text, "1:4").includes("{State:On}") && !lineOf(text, "1:4").includes("component="));
  const long = "x".repeat(500);
  check("full level keeps the whole text", full(source([{ type: "TEXT", name: "T", id: "1:1", text: long }])).text.includes(long));
}

console.log("\nvalues on a line stay unambiguous:");
{
  const text = full(source([{ type: "INSTANCE", name: "I", id: "1:1", props: { Swap: "16538:59888", Flag: "true", On: true, Count: "12" } }, { type: "TEXT", name: "T", id: "1:2", text: "x", font: { family: "SF Pro", weight: "Bold Italic", size: 16 } }])).text;
  check("a node id, a string true and a numeric string are quoted; a real boolean is not", lineOf(text, "1:1").includes('{Swap:"16538:59888",Flag:"true",On:true,Count:"12"}'));
  check("a font family or weight with a space is quoted", lineOf(text, "1:2").includes('"SF Pro"/"Bold Italic"/16'));
  const counts = full(source([{ type: "FRAME", name: "F", id: "1:1" }], manifest({ assetsSkippedInvisible: 6, assetsHidden: 2, hiddenNodes: 3 }))).text;
  check("the invisible and hidden counts are in the header", counts.includes("assetsSkippedInvisible=6") && counts.includes("assetsHidden=2") && counts.includes("hiddenNodes=3"));
}

console.log("\nhoisting:");
{
  const fill = [{ type: "solid" as const, color: "#112233", tokens: { color: "Brand/Primary color" } }];
  const nodes: IrNode[] = [{ type: "FRAME", name: "Root", id: "1:1", children: [
    { type: "RECTANGLE", name: "A", id: "1:2", fills: fill, tokens: { fills: "Brand/Primary color" } },
    { type: "RECTANGLE", name: "B", id: "1:3", fills: fill },
    { type: "RECTANGLE", name: "C", id: "1:4", fills: [{ type: "solid", color: "#445566" }] },
  ] }];
  const text = full(source(nodes)).text;
  check("a repeated value is hoisted to one table row and referenced", text.includes("$C1 #112233{color:\"Brand/Primary color\"}") && lineOf(text, "1:2").includes("fill=$C1") && lineOf(text, "1:3").includes("fill=$C1"));
  check("a value used once stays on its line", lineOf(text, "1:4").includes("fill=#445566") && !text.includes("$C2"));
  check("`tokens.fills` that repeats the fill's own token is not said twice", !lineOf(text, "1:2").includes("tokens="));
}

console.log("\nno silent loss:");
{
  const everything: IrNode = {
    type: "TEXT", name: "N", id: "1:1", box: { w: 1, h: 1 }, text: "hi", tokens: { fills: "Other", gap: "Space 2" }, styles: { text: "label/large" },
    textTokens: { fontSize: "Font/Size" }, propTokens: { Show: "Flag" }, variableModes: { Theme: "Dark" }, resolvedModes: { Theme: "Dark" },
    effects: [{ type: "layer_blur", tokens: { radius: "Shadow/Soft" } }], truncate: true, maxLines: 2, assetSkipped: true,
    fills: [{ type: "solid", color: "#000000", tokens: { color: "Ink" } }],
    runs: [{ text: "hi", font: { size: 12 }, tokens: { fills: "Run/Token" }, textStyle: "body" }],
  };
  const text = full(source([everything])).text;
  for (const name of ["Other", "Space 2", "label/large", "Font/Size", "Flag", "Dark", "Shadow/Soft", "Ink", "Run/Token", "body", "truncate", "maxLines=2", "assetSkipped"]) {
    check(`full level says ${name}`, text.includes(name));
  }
  const carried: IrNode = { type: "FRAME", name: "F", id: "2:1", css: { color: "red" }, reactions: [], motion: {}, renderBox: { x: 0, y: 0, w: 1, h: 1 } };
  const withUnknown: IrNode = Object.assign({}, carried, { fromANewerPlugin: 1 });
  const c = full(source([withUnknown])).text;
  check("a field the line does not carry is counted by name, an unknown one included", /Not shown[^\n]*css:1/.test(c) && /Not shown[^\n]*reactions:1/.test(c) && /Not shown[^\n]*fromANewerPlugin:1/.test(c));
}

console.log("\na thin manifest (an older plugin's reply):");
{
  const thin = { nodes: 1 } as Manifest;
  check("no warnings field is no warnings, not a crash", full(source([{ type: "FRAME", name: "F", id: "1:1" }], thin)).level === "full");
}

console.log("\nthe ladder:");
{
  const bound: IrNode = { type: "RECTANGLE", name: "Box", id: "9:9", box: { w: 5, h: 5 }, fills: [{ type: "solid", color: "#000000", tokens: { color: "Ink" } }], tokens: { gap: "Space 2" }, styles: { fill: "Style" } };
  const kids: IrNode[] = Array.from({ length: 120 }, (_, i) => ({ ...bound, id: "9:" + i, name: "Box " + i, fills: [{ type: "solid", color: "#" + String(100000 + i), tokens: { color: "Tok" + i } }] }));
  const src = source([{ type: "FRAME", name: "Root", id: "1:1", children: kids }], manifest({ nodes: 121, truncated: 2, warnings: ["depth limit 60 reached — deep subtrees truncated (first: X)"] }));
  const fullText = full(src).text;
  const atLayout = screenOutline(src, { limit: fullText.length - 1, more });
  check("past the limit → the layout level", atLayout?.level === "layout");
  check("…which says so, and how to get more", !!atLayout && atLayout.text.startsWith("OUTLINE level=layout") && atLayout.text.includes("More: more-for-layout"));
  check("…keeps the truncation note", !!atLayout && atLayout.text.includes("truncated=2") && atLayout.text.includes("depth limit 60"));
  check("…and counts the bindings it left out", !!atLayout && /Not shown[^\n]*tokens:120/.test(atLayout.text) && /Not shown[^\n]*styles:120/.test(atLayout.text) && /Not shown[^\n]*fills:120/.test(atLayout.text));
  check("…with no binding on the node lines", !!atLayout && !lineOf(atLayout.text, "9:0").includes("Ink") && !lineOf(atLayout.text, "9:0").includes("fill="));
  const atSections = screenOutline(src, { limit: 3000, more });
  check("smaller → the section list, within the limit", atSections?.level === "sections" && atSections.text.length <= 3000);
  check("…naming each section's id and saying how many are not listed", !!atSections && atSections.text.includes("#9:0 [RECTANGLE]") && /\d+ more sections not listed\./.test(atSections.text) && atSections.text.includes("More: more-for-sections"));
  check("…still with the truncation note and the bindings count", !!atSections && atSections.text.includes("depth limit 60") && /Not shown[^\n]*tokens:120/.test(atSections.text));
  const wrapped = source([{ type: "FRAME", name: "Page", id: "1:0", children: [{ type: "FRAME", name: "Wrap", id: "1:5", children: [{ type: "FRAME", name: "Top", id: "2:1" }, { type: "FRAME", name: "Bottom", id: "2:2" }] }] }]);
  const wrappedText = screenOutline(wrapped, { limit: 250, more: () => "" });
  check("a wrapper around one child is looked through for the sections", wrappedText?.level === "sections" && wrappedText.text.includes("#2:1 [FRAME]") && wrappedText.text.includes("#2:2 [FRAME]"));
  const manyWarnings = source([{ type: "FRAME", name: "R", id: "1:1", children: [{ type: "FRAME", name: "A", id: "1:2" }] }], manifest({ warnings: Array.from({ length: 200 }, (_, i) => "warning number " + i + " with a long tail of text") }));
  const w = screenOutline(manyWarnings, { limit: 4000, more });
  check("sections cap the warnings and say how many are left", !!w && w.level === "sections" && /Warnings not listed: \d+ more/.test(w.text) && w.text.length <= 4000);
  check("a limit too small for even the header is null, never over budget", screenOutline(src, { limit: 40, more }) === null);
}

console.log("\nthe real size, on a real screen:");
const fixtures = ["Studio_Configurations__1359_21337.json", "positions___7314_87192.json"].map((f) => path.join(import.meta.dirname, "fixtures", "livetest3", "verify", f));
{
  for (const file of fixtures) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as ScreenExport;
    const compact = JSON.stringify(doc).length;
    const o = full({ screen: doc, screenName: doc.screen });
    const pct = Math.round((100 * o.text.length) / compact);
    console.log(`  ${path.basename(file)}: compact ${compact}, outline ${o.text.length} = ${pct}%`);
    check(`${path.basename(file)}: the full outline is well under the compact JSON`, o.level === "full" && pct <= 45);
    check("…one line per node, plus the header, tables and legend", o.text.split("---\n")[1]?.split("\n").length === doc.manifest?.nodes);
    const capped = screenOutline({ screen: doc, screenName: doc.screen }, { limit: 48000, more });
    console.log(`  at the 48,000-character cap: level ${capped?.level}, ${capped?.text.length} characters`);
    const keys = new Set<string>();
    const collect = (n: IrNode): void => { if (n.mainComponent?.key) keys.add(n.mainComponent.key); (n.children ?? []).forEach(collect); };
    doc.nodes.forEach(collect);
    check("…at the inline cap it still names every component's publish key", !!capped && keys.size > 0 && [...keys].every((k) => capped.text.includes(k)));
    let over = 0;
    for (let limit = 150; limit < 1500; limit++) { const t = screenOutline({ screen: doc, screenName: doc.screen }, { limit, more }); if (t && t.text.length > limit) over++; }
    check("…and no limit near the section header's size is overrun", over === 0);
  }
}

console.log("\n`dtwin outline`, the real CLI:");
{
  const CLI = path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts");
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, "outline", ...args], { encoding: "utf8", timeout: 30000 });
  const file = fixtures[0] as string;
  const ok = run(file);
  check("prints the full outline of a file on disk, naming the file as the source of truth", ok.status === 0 && ok.stdout.startsWith("OUTLINE level=full") && ok.stdout.includes(path.basename(file)));
  const small = run(file, "--budget", "6000");
  check("--budget falls back and stays within it", small.status === 0 && small.stdout.startsWith("OUTLINE level=sections") && small.stdout.length <= 6001);
  check("--help exits 0", run("--help").status === 0 && run("--help").stdout.startsWith("dtwin outline"));
  check("a bad budget, a missing file and a non-screen file are errors", run(file, "--budget", "x").status === 1 && run("/no/such.json").status === 1 && run(path.join(import.meta.dirname, "..", "package.json")).status === 1);
}

report();
