// [children] same-name children told apart: listChildren's childCount / title / distinctTexts and their read budgets,
// and listPages depth 2's childCount + per-page note.
import { ok } from "../assert.ts";
import type { FakeNode, ListChildrenResult } from "../fake-figma.ts";
import { thrown, type Case, type Thrown } from "./helpers.ts";
import { world } from "./scene.ts";

const txt = (id: string, characters: string, visible = true) => ({ type: "TEXT", name: "t", id, visible, characters, width: 10, height: 10 });
// two FRAMEs "Screen A" 1440×1236 told apart by childCount + title (the hidden TEXT skipped), one "Screen B"
const screenA1 = () => ({ type: "FRAME", name: "Screen A", id: "g13s:1", width: 1440, height: 1236, children: [txt("g13s:11", "Welcome back")] });
const screenA2 = () => ({ type: "FRAME", name: "Screen A", id: "g13s:2", width: 1440, height: 1236.2,
  children: [txt("g13s:21", "Draft note", false), txt("g13s:22", "Settings")] });
const screenB = () => ({ type: "FRAME", name: "Screen B", id: "g13s:3", width: 1440, height: 1236, children: [txt("g13s:31", "Other")] });

// ONE budget case and the title-walk case share these: a 3000-node frame whose every `name` read is counted.
const k6BigFrames = () => {
  const reads = { n: 0 };
  const counted = <T extends object>(n: T, name: string): T => Object.defineProperty(n, "name", { get: () => { reads.n++; return name; }, enumerable: true });
  const k6Big = (id: string, name: string, slot = true) => counted({ type: "FRAME", id, width: 800, height: 600, visible: true, children: [
    slot ? counted({ type: "FRAME", id: id + ":pt", visible: true, width: 10, height: 10, children: [counted({ ...txt(id + ":pt:t", "Same heading") }, "Title")] }, "Page Title")
      : counted({ ...txt(id + ":pt:t", "Same heading") }, "Heading"),
    counted({ ...txt(id + ":u", "Own " + id) }, "t"),
    ...Array.from({ length: 2997 }, (_, i) => counted({ type: "FRAME", id: id + ":" + i, width: 1, height: 1, visible: true, children: [] }, "f")),
  ] }, name);
  return { reads, k6Big };
};

export const cases: Case[] = [{
  name: "[children] listChildren: childCount + title on same-name, same-size rows",
  async run() {
    // [children] listChildren: two FRAMEs "Screen A" 1440×1236 told apart by childCount + title
    // (the hidden TEXT skipped), one "Screen B", one TEXT.
    const caption = txt("g13s:4", "Caption");
    // A third same-name pair that is too big to search: the title walk stops at its cap.
    const huge = (id: string) => ({ type: "FRAME", name: "Big", id, width: 10, height: 10,
      children: Array.from({ length: 5001 }, (_, i) => ({ type: "FRAME", name: "f", id: id + ":" + i, width: 1, height: 1, children: [] })) });
    const section = { type: "SECTION", name: "Flows", id: "g13s:0", children: [screenA1(), screenA2(), screenB(), caption, huge("g13s:5"), huge("g13s:6")] };
    // the "Page Title" search uses up its budget on a wide frame, and the first-text
    // fallback still gets one of its own: a heading that is node #2 is found. a hidden colliding row
    // is titled from its own (visible) text.
    const wide = (id: string, heading: string, visible = true) => ({ type: "FRAME", name: "Grid", id, width: 900, height: 600, visible,
      children: [txt(id + ":h", heading), ...Array.from({ length: 6000 }, (_, i) => ({ type: "FRAME", name: "cell", id: id + ":" + i, width: 1, height: 1, children: [] }))] });
    const hiddenTwin = (id: string, label: string, visible: boolean) => ({ type: "FRAME", name: "Sheet", id, width: 300, height: 200, visible, children: [txt(id + ":t", label)] });
    const section2 = { type: "SECTION", name: "More", id: "g13s:9", children: [wide("g13w:1", "Team members"), wide("g13w:2", "Projects"), hiddenTwin("g13w:3", "Filters", false), hiddenTwin("g13w:4", "Sort", true)] };
    const { api } = world({ nodes: { "g13s:0": section, "g13s:9": section2 } });
    const lc = await api.listChildren("g13s:0");
    const lc2 = await api.listChildren("g13s:9");
    const row2 = (id: string) => lc2.children.find((c) => c.id === id);
    ok("a colliding frame with 6000 cells and its heading first is titled by the fallback's own budget",
      row2("g13w:1")?.title === "Team members" && row2("g13w:2")?.title === "Projects" && !lc2.manifest.warnings.some((w) => /no title for 'Grid'/.test(w)));
    ok("a HIDDEN colliding row gets its own visible text as title (hidden:true kept)",
      row2("g13w:3")?.title === "Filters" && row2("g13w:3")?.hidden === true && row2("g13w:4")?.title === "Sort");
    const row = (id: string) => lc.children.find((c) => c.id === id);
    // pre-change: fails — childCount absent.
    ok("[children] childCount on every row with children (1, 2, 1), absent on the TEXT row",
      row("g13s:1")?.childCount === 1 && row("g13s:2")?.childCount === 2 && row("g13s:3")?.childCount === 1 && row("g13s:4")?.childCount === undefined);
    ok("[children] hasChildren still agrees with childCount", row("g13s:1")?.hasChildren === true && row("g13s:4")?.hasChildren === undefined);
    // pre-change: fails — title absent. The hidden "Draft note" is skipped (deriveTitle's rule).
    ok("[children] the two colliding rows carry their first VISIBLE text as title",
      row("g13s:1")?.title === "Welcome back" && row("g13s:2")?.title === "Settings");
    ok("[children] no title on a row with no name+size twin (Screen B, the TEXT)", row("g13s:3")?.title === undefined && row("g13s:4")?.title === undefined);
    ok("[children] a colliding row too big to search gets no title, and says so",
      row("g13s:5")?.title === undefined && lc.manifest.warnings.some((w) => /no title for 'Big' \(g13s:5\): more than 5000 nodes/.test(w)));
    const notes = lc.manifest.warnings.filter((w) => /share name/.test(w));
    ok("[children] one manifest warning per collision group, naming the group and its ids",
      notes.length === 2 && notes.some((w) => /^2 children share name 'Screen A' and size 1440×1236 — told apart by `title`\/`childCount`.*dtwin screenshot.*g13s:1, g13s:2/.test(w)));
  },
}, {
  name: "colliding rows whose titles match too: `distinctTexts`",
  async run() {
    // colliding rows whose titles match too: `distinctTexts` — <= 3 texts that row shows and its twins
    // do not. Texts NO twin has come first (U), then those not on EVERY row (N∖U); placeholders and hidden
    // texts are skipped; each cut to 60 chars. The unique text sits late, behind the shared chrome.
    const chrome = (id: string) => [
      { type: "FRAME", name: "Page Title", id: id + ":pt", visible: true, width: 10, height: 10, children: [{ ...txt(id + ":pt:t", "Shared heading"), name: "Title" }] },
      ...["Home", "Reports", "Settings", "Help", "Sign out"].map((t, i) => txt(id + ":c" + i, t)),
    ];
    const k6Screen = (id: string, extra: FakeNode[]) => ({ type: "FRAME", name: "Screen", id, width: 1440, height: 900, children: [...chrome(id), ...extra] });
    const longText = "A very long status line that goes on well past the sixty character cut";
    const k6Rows = [
      k6Screen("g21k:1", [txt("g21k:1a", "Gamma shared"), txt("g21k:1h", "Draft only", false), txt("g21k:1b", "Alpha only")]),
      k6Screen("g21k:2", [txt("g21k:2p", "Label"), txt("g21k:2a", "Beta only"), txt("g21k:2b", longText)]),
      k6Screen("g21k:3", [txt("g21k:3a", "Gamma shared"), txt("g21k:3b", "Line one\n  Line\ttwo ")]),
    ];
    const k6Titled = (id: string, title: string) => ({ type: "FRAME", name: "Card", id, width: 300, height: 200, children: [txt(id + ":t", title), txt(id + ":u", "Only " + title)] });
    // Too big to read whole: the shared first text is the title of both; the walk ends at the cap (soft), so
    // the early unique text is found and the late one is not — no throw.
    const k6Huge = (id: string, early: string) => ({ type: "FRAME", name: "Huge", id, width: 50, height: 50, children: [txt(id + ":s", "Shared top"), txt(id + ":e", early),
      ...Array.from({ length: 5001 }, (_, i) => ({ type: "FRAME", name: "f", id: id + ":" + i, width: 1, height: 1, children: [] })), txt(id + ":l", "Late " + early)] });
    const k6Section = { type: "SECTION", name: "Flows", id: "g21k:0", children: [...k6Rows, k6Titled("g21k:4", "One"), k6Titled("g21k:5", "Two"),
      k6Huge("g21k:6", "First huge"), k6Huge("g21k:7", "Second huge")] };
    const { api } = world({ nodes: { "g21k:0": k6Section } });
    let k6: ListChildrenResult | null = null;
    let k6Err: Thrown | null = null;
    try { k6 = await api.listChildren("g21k:0"); } catch (e) { k6Err = thrown(e); }
    const k6Row = (id: string) => k6?.children.find((c) => c.id === id);
    ok("listChildren over a too-big colliding pair does not throw (" + (k6Err ? k6Err.message : "") + ")", !!k6 && !k6Err);
    ok("the three 'Screen' rows share their title", ["g21k:1", "g21k:2", "g21k:3"].every((id) => k6Row(id)?.title === "Shared heading"));
    ok("a row's own text comes first, ahead of a text only some twins share",
      JSON.stringify(k6Row("g21k:1")?.distinctTexts) === '["Alpha only","Gamma shared"]');
    ok("a placeholder is skipped and each text is cut to 60 chars",
      JSON.stringify(k6Row("g21k:2")?.distinctTexts) === JSON.stringify(["Beta only", longText.slice(0, 60)]));
    ok("a multi-line text is one line (whitespace and line breaks collapsed), ahead of a text only some twins share",
      JSON.stringify(k6Row("g21k:3")?.distinctTexts) === '["Line one Line two","Gamma shared"]');
    ok("rows whose titles already differ get no distinctTexts", k6Row("g21k:4")?.title === "One" && k6Row("g21k:4")?.distinctTexts === undefined &&
      k6Row("g21k:5")?.distinctTexts === undefined);
    ok("a pair past the visit cap gets partial lists (the early text, never the late one) and a warning",
      JSON.stringify(k6Row("g21k:6")?.distinctTexts) === '["First huge"]' && JSON.stringify(k6Row("g21k:7")?.distinctTexts) === '["Second huge"]' &&
      !!k6?.manifest.warnings.some((w) => /`distinctTexts` for 'Huge' \(g21k:6\) read only its first 5000 nodes/.test(w)));
    ok("no row lists more than 3 texts",
      !!k6 && k6.children.every((c) => (c.distinctTexts || []).length <= 3));
    ok("the collision note names `distinctTexts`",
      !!k6?.manifest.warnings.some((w) => /^3 children share name 'Screen' .*told apart by `title`\/`childCount`\/`distinctTexts`/.test(w)));
  },
}, {
  name: "ONE budget of 20000 extra node reads for the whole listing",
  async run() {
    // ONE budget of 20000 extra node reads for the whole listing, shared across collision groups: two
    // groups of four 3000-node twins (a cheap "Page Title" title each, so the reads are distinctTexts'). Six rows
    // fit (18000), the 7th runs it out mid-walk, the 8th is never read — then NO row of that group gets any (a
    // "unique" text cannot be claimed against unread twins), one warning names them, no throw, and the listing reads no
    // more than the budget plus the title walks (counted on every node's `name`). A cheap pair after the heavy groups
    // is still titled (the title search never depends on the spent budget).
    const { reads, k6Big } = k6BigFrames();
    const k6BigSection = { type: "SECTION", name: "Explorations", id: "g21b:0", children: [
      ...[1, 2, 3, 4].map((i) => k6Big("g21b:a" + i, "Big A")), ...[1, 2, 3, 4].map((i) => k6Big("g21b:b" + i, "Big B")),
      ...["Alpha", "Beta"].map((t, i) => ({ type: "FRAME", name: "Small", id: "g21b:s" + i, width: 20, height: 20, visible: true,
        children: [{ type: "FRAME", name: "Page Title", id: "g21b:s" + i + ":pt", width: 10, height: 10, visible: true, children: [{ ...txt("g21b:s" + i + ":t", t), name: "Title" }] }] }))] };
    const { api } = world({ nodes: { "g21b:0": k6BigSection } });
    let k6b: ListChildrenResult | null = null;
    let k6bErr: Thrown | null = null;
    reads.n = 0;
    try { k6b = await api.listChildren("g21b:0"); } catch (e) { k6bErr = thrown(e); }
    const k6Reads = reads.n;
    const k6bRow = (id: string) => k6b?.children.find((c) => c.id === id);
    ok("a listing of many big colliding frames does not throw (" + (k6bErr ? k6bErr.message : "") + ")", !!k6b && !k6bErr);
    ok("reads stay within the listing budget (20000) plus the title walks (" + k6Reads + ")", k6Reads <= 20000 + 200);
    ok("a group read in full before the budget ran out gets its own texts",
      ["g21b:a1", "g21b:a2", "g21b:a3", "g21b:a4"].every((id) => k6bRow(id)?.distinctTexts?.[0] === "Own " + id));
    ok("the group the budget ran out in gets NO distinctTexts — not even its fully read rows (twins unread)",
      ["g21b:b1", "g21b:b2", "g21b:b3", "g21b:b4"].every((id) => k6bRow(id)?.distinctTexts === undefined) && k6bRow("g21b:b4")?.title === "Same heading");
    ok("a cheap pair AFTER the spent budget is still titled",
      k6bRow("g21b:s0")?.title === "Alpha" && k6bRow("g21b:s1")?.title === "Beta");
    ok("ONE warning names the listing budget and the rows it skipped",
      k6b?.manifest.warnings.filter((w) => /distinctTexts/.test(w) && /budget/.test(w)).length === 1 &&
      !!k6b.manifest.warnings.some((w) => /^`distinctTexts` skipped for 4 row\(s\) \(g21b:b1, g21b:b2, g21b:b3, g21b:b4\): the listing's budget of 20000 node reads ran out/.test(w)));
  },
}, {
  name: "the title search and distinctTexts share one walk",
  async run() {
    // The same walk feeds both: with no "Page Title" slot the title search reads every node of each frame, and
    // distinctTexts then walks those SAME (memoised) nodes for free — all eight rows get theirs, no budget warning,
    // and the listing reads each node about once (a second walk per row would read ~2 × 8 × 3000).
    const { reads, k6Big } = k6BigFrames();
    const k6WalkedSection = { type: "SECTION", name: "Explorations", id: "g21w:0", children: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => k6Big("g21w:" + i, "Walked", false)) };
    const { api } = world({ nodes: { "g21w:0": k6WalkedSection } });
    reads.n = 0;
    const k6w = await api.listChildren("g21w:0");
    const k6Reads = reads.n;
    ok("nodes the title search already read cost distinctTexts nothing: every row gets its own text, no budget warning, ~one read per node (" + k6Reads + ")",
      k6w.children.every((c) => c.title === "Same heading" && c.distinctTexts?.[0] === "Own " + c.id) && k6Reads <= 8 * 3000 + 200 &&
      !k6w.manifest.warnings.some((w) => /budget/.test(w)));
  },
}, {
  name: "[children] listPages depth 2: childCount through the same summarize(), plus the per-page note",
  async run() {
    // listPages depth 2: childCount through the same summarize(), plus the per-page note (no titles).
    const { api } = world({ pages: [{ type: "PAGE", name: "Flows", id: "g13pg:1", loadAsync: async () => {}, children: [screenA1(), screenA2(), screenB()] }] });
    const lp = await api.listPages({ depth: 2 });
    const lpFrames = lp.pages[0]?.frames || [];
    ok("[children] listPages frames carry childCount, never title",
      lpFrames.map((f) => f.childCount).join() === "1,2,1" && lpFrames.every((f) => f.title === undefined));
    ok("[children] listPages notes the same-name group once, per page",
      lp.manifest.warnings.filter((w) => /^page 'Flows': 2 frames share name 'Screen A'/.test(w)).length === 1);
  },
}];
