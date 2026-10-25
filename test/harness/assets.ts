// [NOASSETS] skipAssets, [NOASSETS-SHAPE], asset naming and dedupe, the missing-font flag, the bounded css auto-on,
// and the source-image container format.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode } from "../fake-figma.ts";
import { gate, settle, type Case } from "./helpers.ts";
import { world } from "./scene.ts";

// --- [NOASSETS-SHAPE]'s icon sheet (the [MANIFEST] checks read over it too)
// Several vector children, and the icon nested one level down: with a single child the two trees
// differ by too little for the node-count/size assertions below to actually discriminate.
const iconVec = (i: number) => ({ type: "VECTOR", name: "path" + i, visible: true, id: "ic:v" + i, width: 16, height: 16,
  fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
  exportAsync: async () => "<svg/>" });
const iconSheetOf = () => {
  const iconFrame = { type: "FRAME", name: "icon/home", visible: true, id: "ic:1", width: 24, height: 24,
    children: [iconVec(1), iconVec(2), iconVec(3)], findOne: () => null, exportAsync: async () => "<svg/>" };
  return { type: "FRAME", name: "Sheet", visible: true, id: "ic:0", width: 100, height: 100,
    children: [iconFrame], exportAsync: async () => new Uint8Array([137, 80, 78, 71]) };
};

export const cases: Case[] = [{
  name: "[NOASSETS] skipAssets",
  async run() {
    // --- [NOASSETS] skipAssets: the per-node exportAsync pass is the dominant cost on a real file
    // (it hung a ~1000-node page past 300s and outgrew the bridge's frame limit on --all-pages), yet it
    // was the only O(nodes) read with no opt-out — getCSSAsync, its cheaper twin, has had one all along.
    // Skipping must be LOUD: a missing `asset` is otherwise indistinguishable from "no graphic here".
    // Driven through the PUBLIC collect API (not by poking the run's reads), so the test exercises the same
    // path figma-pull --no-assets uses rather than an internal it could drift from.
    let exportCalls = 0;
    const countingRect = { type: "RECTANGLE", name: "Photo2", visible: true, id: "img:2", width: 40, height: 40,
      fills: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: "abc123" }],
      exportAsync: async () => { exportCalls++; return new Uint8Array([137, 80, 78, 71]); } };
    const w = world({ selection: [countingRect] });
    const { api } = w;

    const skipRun = await api.collectSelection({ skipAssets: true });
    const skipCalls = exportCalls;
    const skipNode = must(skipRun.screen.nodes[0], "skipRun.screen.nodes[0]");
    ok("[NOASSETS] no asset is emitted when skipping", skipNode.asset === undefined);
    // The per-ROOT reference screenshot is deliberately still taken: it's one render per exported root
    // (the self-correction image), not the O(nodes) pass that caused the hang. So the contract is
    // "no PER-NODE asset export", not "no exportAsync at all" — pin that precisely.
    ok("[NOASSETS] the per-node asset export does not run (only the 1 reference render)", skipCalls <= 1);
    ok("[NOASSETS] the reference screenshot IS still produced", typeof skipNode.reference === "string" || skipRun.assets.some((a) => a.kind === "reference"));
    ok("[NOASSETS] the skip is COUNTED, not silent", skipRun.screen.manifest.assetsSkipped >= 1);
    ok("[NOASSETS] and warned — a missing `asset` must not read as 'no graphic here'",
      skipRun.screen.manifest.warnings.some((m) => /--no-assets/.test(m) && /skipped/.test(m)));

    const normalRun = await api.collectSelection({});
    ok("[NOASSETS] DEFAULT is unchanged — the asset still exports",
      typeof must(normalRun.screen.nodes[0], "normalRun.screen.nodes[0]").asset === "string");

    ok("[NOASSETS] and exportAsync did run when not skipping", exportCalls > skipCalls);
    ok("[NOASSETS] a normal run reports assetsSkipped: 0", normalRun.screen.manifest.assetsSkipped === 0);
    // The [MANIFEST] checks read over [NOASSETS-SHAPE]'s icon sheet.
    w.figma.currentPage.selection = [iconSheetOf()];
    // Which OPT-IN reads ran. An absent `codeSyntax`/`annotations`/`measurements` would be
    // indistinguishable from "the read was never asked for", which silently kills two of
    // build-screen's six hint tiers with nothing to say so.
    ok("[MANIFEST] the manifest names the opt-in reads that actually ran",
      Array.isArray(normalRun.screen.manifest.reads));
    ok("[MANIFEST] an opt-in read that was requested appears in it",
      must((await api.collectSelection({ measurements: true })).screen.manifest.reads, "manifest.reads").includes("measurements"));
    ok("[MANIFEST] one that was not, does not",
      !must((await api.collectSelection({})).screen.manifest.reads, "manifest.reads").includes("measurements"));
  },
}, {
  name: "[NOASSETS-SHAPE] a flattened container stays flattened when skipping",
  async run() {
    // --- [NOASSETS-SHAPE] a FLATTENED CONTAINER must stay flattened when skipping ---
    // The case above is a childless RECTANGLE — a leaf either way, so it cannot catch the real bug:
    // an `iconLike` CONTAINER (icon-named, <=96px, no TEXT descendant) is normally flattened to ONE
    // svg and serialized as a leaf. When --no-assets returned `undefined` for it, serialize recursed
    // into its vector guts instead, so the flag QUIETLY CHANGED THE TREE it promises not to touch —
    // measured 41 -> 161 nodes and 4.3x the JSON on a 40-icon sheet, i.e. the flag INFLATED the very
    // payload it exists to shrink (and the skip counter counted those child vectors, not the exports).
    const { api } = world({ selection: [iconSheetOf()] });
    const iconNormal = await api.collectSelection({});
    const iconSkipped = await api.collectSelection({ skipAssets: true });
    const nNode = must(must(must(iconNormal.screen.nodes[0], "iconNormal.screen.nodes[0]").children, "iconNormal tree children")[0], "iconNormal tree children[0]");
    const sNode = must(must(must(iconSkipped.screen.nodes[0], "iconSkipped.screen.nodes[0]").children, "iconSkipped tree children")[0], "iconSkipped tree children[0]");

    ok("[NOASSETS-SHAPE] normally the icon container flattens to one asset leaf",
      typeof nNode.asset === "string" && !nNode.children);
    ok("[NOASSETS-SHAPE] --no-assets keeps it a LEAF — no descent into the icon's vectors",
      sNode.asset === undefined && !sNode.children);
    ok("[NOASSETS-SHAPE] the node count is IDENTICAL to the full export (structure unaffected)",
      iconSkipped.screen.manifest.nodes === iconNormal.screen.manifest.nodes);
    ok("[NOASSETS-SHAPE] and the tree is no larger than the full export's",
      JSON.stringify(iconSkipped.screen.nodes).length <= JSON.stringify(iconNormal.screen.nodes).length);
    // Per-node, not just a manifest total: a consumer must be able to tell "graphic omitted here" from
    // "this node has no graphic" at the node it cares about.
    ok("[NOASSETS-SHAPE] the omission is marked ON the node, not only counted",
      sNode.assetSkipped === true);
    ok("[NOASSETS-SHAPE] the counter matches the exports that would REALLY have happened (1, not 2)",
      iconSkipped.screen.manifest.assetsSkipped === 1);
    ok("[NOASSETS-SHAPE] no assetSkipped flag leaks into a normal run", nNode.assetSkipped === undefined);
  },
}, {
  name: "asset NAMING and DEDUPE",
  async run() {
    // ---- asset NAMING and DEDUPE
    // Names came from the node-id PATH, which included the whole instance chain: an app importing 41
    // icons imported 41 filenames like `I10970_111374_1910_23337_1902_19173.svg`, and one shared
    // sidebar icon was re-exported under a different name for every screen that used it.
    const svgIcon = (id: string, name: string, body: string) => ({ type: "VECTOR", name, visible: true, id, width: 16, height: 16,
      fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
      exportAsync: async () => body });
    const namedSheet = { type: "FRAME", name: "Names", visible: true, id: "an:0", width: 100, height: 100,
      children: [
        svgIcon("I1:2:3", "vuesax/linear/element-4", "<svg>A</svg>"),
        svgIcon("I9:8:7", "Side menu tabs/vuesax/linear/element-4", "<svg>A</svg>"), // same artwork, another instance path
        svgIcon("I4:5:6", "Linear / School / Diploma", "<svg>B</svg>"),
        svgIcon("I7:7:7", "misc/Diploma", "<svg>C</svg>"), // same leaf name, DIFFERENT artwork
      ],
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]) };
    const { api } = world({ selection: [namedSheet] });
    const named = await api.collectSelection({});
    const icons = named.assets.filter((a) => a.format === "svg");
    const fileOf = (n: string) => { const a = icons.find((x) => x.name === n); return a && a.file; };

    ok("[ASSET-NAME] an icon is named after its Figma layer, not its node-id path", fileOf("vuesax/linear/element-4") === "element-4.svg");
    ok("[ASSET-NAME] the hyphen survives — it is the commonest character in an icon name",
      icons.every((a) => a.file.indexOf("/") === -1) && must(fileOf("vuesax/linear/element-4"), "fileOf(vuesax/linear/element-4)").indexOf("-") !== -1);
    ok("[ASSET-NAME] a slash-pathed layer name files under its LAST segment, trimmed", fileOf("Linear / School / Diploma") === "Diploma.svg");
    ok("[ASSET-DEDUPE] the same artwork reached through two instance paths produces ONE file", icons.length === 3);
    ok("[ASSET-DEDUPE] and both node ids are recorded on the file that survived",!!(
      (() => { const a = must(icons.find((x) => x.file === "element-4.svg"), "icons element-4.svg"); return a.from && a.from.indexOf("I1:2:3") !== -1 && a.from.indexOf("I9:8:7") !== -1; })()));
    ok("[ASSET-DEDUPE] the deduped node's tree path points at that same one file",
      named.screen.nodes[0]?.children?.[1]?.asset === "assets/element-4.svg");
    ok("[ASSET-NAME] two DIFFERENT icons sharing a leaf name both survive, told apart by content",!!(
      (() => { const f = fileOf("misc/Diploma"); return f && f !== "Diploma.svg" && /^Diploma-[0-9a-f]{6}\.svg$/.test(f); })()));
    ok("[ASSET-NAME] every filename is still separator-free and ends in its format",
      named.assets.every((a) => a.file.indexOf("/") === -1 && a.file.endsWith("." + a.format)));
  },
}, {
  name: "missing font flag and uniform variationSettings",
  async run() {
    const { api } = world();
    // serialize() reads the run options the last collector left: these checks read them as a defaulted
    // collectSelection({}) over a small selection leaves them (css auto-on).
    await api.collectSelection({});
    // --- FIX: hasMissingFont -> flag + warning so codegen knows the recorded font may be substituted ---
    const legacyText = { type: "TEXT", name: "Legacy", visible: true, id: "t:missing", characters: "x", width: 50,
      fontName: { family: "Proxima Nova", style: "Regular" }, fontSize: 12, hasMissingFont: true, getStyledTextSegments: () => [] };
    const legacy = await api.serialize(legacyText, 0, false);
    ok("missing font flagged on text node", legacy.missingFont === true);

    // FontName.variationSettings (Update 138) on a UNIFORM (single-run) text node — the node-level
    // fontName read, not a styled-text segment.
    const variableFontText = { type: "TEXT", name: "Variable", visible: true, id: "t:varfont", characters: "x", width: 50,
      fontName: { family: "Roboto Flex", style: "Regular", variationSettings: { wght: 600 } }, fontSize: 12, getStyledTextSegments: () => [] };
    const varFont = await api.serialize(variableFontText, 0, false);
    ok("uniform text node's fontName.variationSettings emitted on font", JSON.stringify(varFont.font?.variationSettings) === '{"wght":600}');
    const staticFontText = { type: "TEXT", name: "Static", visible: true, id: "t:staticfont", characters: "x", width: 50,
      fontName: { family: "Roboto", style: "Regular" }, fontSize: 12, getStyledTextSegments: () => [] };
    const staticFont = await api.serialize(staticFontText, 0, false);
    ok("uniform text node without variationSettings has no such key", !("variationSettings" in must(staticFont.font, "staticFont.font")));
  },
}, {
  name: "css auto-on is bounded",
  async run() {
    // --- FIX: css auto-on is bounded — a LARGE single selection keeps the per-node oracle OFF ---
    const bigKids = [];
    for (let i = 0; i < 70; i++) bigKids.push({ type: "RECTANGLE", name: "r" + i, visible: true, id: "big:" + (i + 1), fills: [] });
    const bigFrame = { type: "FRAME", name: "Big", visible: true, id: "big:0", layoutMode: "NONE",
      width: 100, height: 100, getCSSAsync: async () => ({ display: "block" }), children: bigKids };
    const w = world({ selection: [bigFrame] });
    const selBig = await w.api.collectSelection();
    ok("css stays OFF for large single selection (>cap)", must(selBig.screen.nodes[0], "selBig.screen.nodes[0]").css === undefined);
    // explicit css:false always wins, even on a small tree.
    w.figma.currentPage.selection = [w.fx.scrollFrame];
    const selNoCss = await w.api.collectSelection({ css: false });
    ok("explicit css:false wins over auto-enable", must(selNoCss.screen.nodes[0], "selNoCss.screen.nodes[0]").css === undefined);
  },
}, {
  name: "source-image container format (magic bytes)",
  async run() {
    // ---- source-image container format (magic bytes, not a hardcoded ".img") ----
    const magicRect = (hash: string) => ({ type: "RECTANGLE", name: "Photo", visible: true, id: "m:" + hash, width: 10, height: 10,
      fills: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: hash }], exportAsync: async () => new Uint8Array([137, 80, 78, 71]) });
    const MAGIC = {
      png: [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10],
      jpg: [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46],
      gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 1],
      webp: [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
    };
    for (const [fmt, bytes] of Object.entries(MAGIC)) {
      const { api } = world({
        selection: [magicRect("h_" + fmt)],
        images: { ["h_" + fmt]: { getSizeAsync: async () => ({ width: 8, height: 8 }), getBytesAsync: async () => new Uint8Array(bytes) } },
      });
      const r = await api.collectSelection({ css: false });
      ok(`source image format detected from magic bytes: ${fmt}`, r.assets.some((a) => a.kind === "source" && a.format === fmt));
    }
  },
}, {
  name: "[SOURCE-BYTES] a reply that delivers no assets reads an image's size, not its original bytes",
  async run() {
    // collectDesignSystemOnly / collectLibraryFile replies have no `assets` field: an image fill's original bytes read
    // there (getBytesAsync + base64) went nowhere. The intrinsic size is on the paint record and must stay.
    let sizeReads = 0, byteReads = 0;
    const style = { name: "Brand/Photo", id: "s_photo", key: "photokey", description: "", paints: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: "h_src" }] };
    const w = world({
      localStyles: { paint: [style] },
      images: { h_src: { getSizeAsync: async () => { sizeReads++; return { width: 8, height: 6 }; }, getBytesAsync: async () => { byteReads++; return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]); } } },
    });
    const { api } = w;
    const SIZE = '"intrinsicSize":{"w":8,"h":6}';
    const ds = await api.collectDesignSystemOnly({});
    ok(`[SOURCE-BYTES] design-system pull: the size is read and kept, the bytes are not read (size ${sizeReads}, bytes ${byteReads})`,
      sizeReads === 1 && byteReads === 0 && JSON.stringify(ds.designSystem).includes(SIZE));
    sizeReads = 0; byteReads = 0;
    const lib = await api.collectLibraryFile({ asLibrary: "Lib" });
    ok(`[SOURCE-BYTES] library pull: the same (size ${sizeReads}, bytes ${byteReads})`,
      sizeReads === 1 && byteReads === 0 && JSON.stringify(lib.designSystem).includes(SIZE));
    sizeReads = 0; byteReads = 0;
    // a full export delivers assets: there the original bytes are read and shipped as before
    const full = await api.collectFull({ css: false });
    ok(`[SOURCE-BYTES] a full export still reads and delivers them (size ${sizeReads}, bytes ${byteReads})`,
      sizeReads === 1 && byteReads === 1 && full.assets.some((a) => a.kind === "source" && a.id === "img:h_src" && a.format === "png")
      && JSON.stringify(full.designSystem).includes(SIZE));
    // and the flag does not leak: a design-system pull followed by a full one in the same plugin session
    sizeReads = 0; byteReads = 0;
    await api.collectDesignSystemOnly({});
    const again = await api.collectFull({ css: false });
    ok("[SOURCE-BYTES] …also right after a design-system pull (the flag is per run)", byteReads === 1 && again.assets.some((a) => a.kind === "source"));
  },
}, {
  name: "[ASSET-RELEASE] a settled run keeps no asset payloads",
  async run() {
    // The dedupe table (assets.ts byContent) holds the same Asset objects the run returned. Emptying
    // only the asset array when a run settled left the last export's payloads reachable until the next
    // run started. Every way a run can settle must leave all three tables empty — while what the run
    // returned stays intact (the release drops references, it never mutates the returned objects).
    const EMPTY = JSON.stringify({ assets: 0, byContent: 0, byName: 0 });
    const icon = (id: string, body: string, onExport?: () => void): FakeNode => ({ type: "VECTOR", name: "glyph-" + id, visible: true, id, width: 16, height: 16,
      fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
      exportAsync: async () => { onExport?.(); return body; } });
    const frame = (id: string, children: FakeNode[]): FakeNode => ({ type: "FRAME", name: "Rel " + id, visible: true, id, width: 100, height: 100,
      layoutMode: "NONE", children, exportAsync: async () => new Uint8Array([137, 80, 78, 71]) });
    const w = world({ selection: [frame("rel:1", [icon("rel:a", "<svg>a</svg>"), icon("rel:b", "<svg>a</svg>"), icon("rel:c", "<svg>c</svg>")])] });
    const { api } = w;
    const retained = (): string => JSON.stringify(api.assetRetention());

    // success
    const r = await api.serializeRun(() => api.collectSelection({ css: false }), { source: "ui", label: "rel-ok" });
    ok("[ASSET-RELEASE] success: the settled run retains nothing", retained() === EMPTY);
    const a = r.assets.find((x) => x.id === "rel:a");
    ok("[ASSET-RELEASE] success: the returned assets are complete (2 deduped SVGs + the reference PNG)",
      r.assets.filter((x) => x.format === "svg").length === 2 && r.assets.some((x) => x.kind === "reference"));
    ok("[ASSET-RELEASE] success: returned payloads and dedupe provenance are untouched by the release",
      !!a && a.text === "<svg>a</svg>" && JSON.stringify(a.from) === '["rel:a","rel:b"]');

    // a run that throws after collecting
    const thrownRun = await settle(api.serializeRun(async () => { await api.collectSelection({ css: false }); throw new Error("boom"); },
      { source: "ui", label: "rel-throw" }));
    ok("[ASSET-RELEASE] error: the run failed and retains nothing", thrownRun.err?.message === "boom" && retained() === EMPTY);

    // a run cancelled mid-walk (rel:x registers, rel:y arms the cancel, rel:z's checkpoint throws)
    w.figma.currentPage.selection = [frame("rel:2", [icon("rel:x", "<svg>x</svg>"), icon("rel:y", "<svg>y</svg>", () => { api.requestCancel(); }),
      icon("rel:z", "<svg>z</svg>")])];
    const cancelled = await settle(api.serializeRun(() => api.collectSelection({ css: false }), { source: "ui", label: "rel-cancel" }));
    ok("[ASSET-RELEASE] cancel: the run was cancelled and retains nothing", cancelled.err !== null && retained() === EMPTY);

    // a queued next run: A holds the chain while B waits; each gets its own complete result
    w.figma.currentPage.selection = [frame("rel:1", [icon("rel:a", "<svg>a</svg>"), icon("rel:c", "<svg>c</svg>")])];
    const g = gate();
    const pA = api.serializeRun(async () => { const out = await api.collectSelection({ css: false }); await g.p; return out; }, { source: "bridge", label: "rel-A" });
    const pB = api.serializeRun(() => api.collectSelection({ css: false }), { source: "bridge", label: "rel-B" });
    g.open();
    const [rA, rB] = await Promise.all([pA, pB]);
    ok("[ASSET-RELEASE] queued: both runs return their own complete assets",
      rA.assets.filter((x) => x.format === "svg").length === 2 && rB.assets.filter((x) => x.format === "svg").length === 2 &&
      rA.assets.find((x) => x.id === "rel:c")?.text === "<svg>c</svg>");
    ok("[ASSET-RELEASE] queued: nothing is retained once both settle", retained() === EMPTY);
  },
}];
