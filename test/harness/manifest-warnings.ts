// The warnings manifest is aggregated by kind, not one entry per node.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

const vecHost = (id: string, kids: FakeNode[]): FakeNode => ({ type: "FRAME", name: "Host" + id, visible: true, id: "vh:" + id,
  width: 100, height: 100, layoutMode: "NONE", children: kids,
  exportAsync: async () => new Uint8Array([137, 80, 78, 71]) });

export const cases: Case[] = [{
  // ---- the warnings manifest is aggregated by kind, not one entry per node ----
  // A real export produced 896 warnings, ~800 asset failures + 80 identical missingFont sentences.
  // At that length the list is not readable, and the one-off warnings that DO need attention (an
  // unreadable page, a failed page load) are invisible inside it. The manifest stays a flat string[].
  name: "the warnings manifest is aggregated by kind, not one entry per node",
  async run() {
    const missingFontText = (i: number): FakeNode => ({ type: "TEXT", name: "Label" + i, visible: true, id: "mf:" + i, characters: "x", width: 50,
      fontName: { family: "Proxima Nova", style: "Regular" }, fontSize: 12, hasMissingFont: true, getStyledTextSegments: () => [] });
    const manyFonts: FakeNode[] = [];
    for (let i = 1; i <= 12; i++) manyFonts.push(missingFontText(i));
    const aggRun = await world({ selection: [vecHost("fonts", manyFonts)] }).api.collectSelection({ css: false });
    const aggWarnings = aggRun.screen.manifest.warnings;
    const fontLines = aggWarnings.filter((w) => /missing font/.test(w));

    ok("12 missing-font nodes produce ONE warning, not 12", fontLines.length === 1);
    const fontLine0 = must(fontLines[0], "fontLines[0]");
    ok("the summary carries the real count", /12 node\(s\)/.test(fontLine0));
    ok("and example nodes, so it stays actionable", /Label1 \(mf:1\)/.test(fontLine0));
    ok("examples are capped (~10) and the remainder is stated, not silently dropped",
      /\(\+2 more\)/.test(fontLine0) && (fontLine0.match(/mf:/g) || []).length === 10);
    // Backward compatibility: the skill's "read warnings first" step reads a plain list of strings.
    ok("the manifest is still a flat array of strings", Array.isArray(aggWarnings) && aggWarnings.every((w) => typeof w === "string"));
    // Per-node flags are untouched — aggregation is about the MANIFEST, not about hiding the signal.
    ok("every affected node still carries its own missingFont flag",
      must(must(aggRun.screen.nodes[0], "aggRun.screen.nodes[0]").children, "aggRun tree children").every((c) => c.missingFont === true));
  },
}];
