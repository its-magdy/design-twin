// The design system: variables (tiers, aliases by mode name, codeSyntax, keys, hygiene), collections, the style kinds
// (custom animation styles included), the component catalog, and the collectDesignSystemOnly collector around it.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { Scene } from "../fake-figma.ts";
import { STYLE_KINDS } from "../../bridge/src/design-system-layout.ts";
import { aliasOf, flatPaint, type Case } from "./helpers.ts";
import { world, CAS1_ENTRIES } from "./scene.ts";
import { MIXED } from "../fake-figma.ts";

/** `buildDesignSystem()` called directly, after a `collectSelection()` on the same file. That read leaves the variable-name memo holding every id the selection referenced (run.ts
 *  Run.varName — the selection's run is still the one in progress), and dumpVariables reads `varName.ids()` as the reference set it resolves library variables from — so
 *  the selection read runs first here too, rather than building the catalog from an empty memo. */
async function designSystem(delta: Scene = {}) {
  const w = world(delta);
  await w.api.collectSelection();
  return w.api.buildDesignSystem();
}

export const cases: Case[] = [{
  name: "buildDesignSystem: variables, tiers, hygiene, style kinds, custom animation catalog",
  async run() {
    const ds = await designSystem();
    const primary = ds.variables.find((v) => v.name === "color/primary");
    ok("variable tier semantic", !!(primary && primary.tier === "semantic"));
    ok("variable codeSyntax carried", !!(primary && primary.codeSyntax && primary.codeSyntax.WEB === "var(--color-primary)"));
    ok("variable alias re-keyed by mode name", !!(primary && primary.values.Light && aliasOf(primary.values.Light) === "blue/600"));
    const blue600 = must(ds.variables.find((v) => v.name === "blue/600"), "ds.variables blue/600");
    ok("COLOR primitive folded to hex", blue600.values.Value === "#1a4de6");
    ok("variable hiddenFromPublishing captured", blue600.hiddenFromPublishing === true);
    ok("variable key captured (durable identity)", blue600.key === "varkey_blue600");
    ok("public variable has no hiddenFromPublishing flag", primary !== undefined && primary.hiddenFromPublishing === undefined);
    ok("hygiene: ALL_SCOPES flagged", ds.hygiene.some((h) => h.indexOf("ALL_SCOPES") !== -1));
    // tier regression: a raw (non-alias) variable whose only scope is the ALL_SCOPES default is a
    // primitive, not semantic — ALL_SCOPES must not be treated as a meaningful scope.
    ok("tier: raw + ALL_SCOPES-only => primitive", (ds.variables.find((v) => v.name === "misc/bad") || {}).tier === "primitive");
    ok("the plugin reads exactly the style kinds the design-system layout files (STYLE_KINDS), in its order",
      JSON.stringify(Object.keys(ds.styles)) === JSON.stringify(STYLE_KINDS.map((k) => k.kind)));
    const paintStyle0Paint0 = ds.styles.paint[0]?.paints?.[0];
    ok("paint style carries color value", paintStyle0Paint0 !== undefined && flatPaint(paintStyle0Paint0).color === "#1a4de6");
    const gridStyle0Grid0 = ds.styles.grid[0]?.grids?.[0];
    ok("grid style exported", gridStyle0Grid0 !== undefined && gridStyle0Grid0.count === 12);
    ok("custom animation style catalogued: name, entries (same form as an applied style), description, key, id",
      JSON.stringify(ds.styles.animation[0]) === '{"name":"Brand Entrance","entries":[' + CAS1_ENTRIES + '],"description":"Hero entrance sequence","key":"caskey1","id":"cas1"}');
    ok("custom animation style whose animationEntries read throws: catalogued without entries (no partial list), empty description dropped",
      JSON.stringify(ds.styles.animation[1]) === '{"name":"Broken","id":"cas_broken"}' && ds.styles.animation.length === 3);
    ok("custom animation style whose animationEntries list is empty: catalogued with entries: [] (an empty style, not an unreadable one)",
      JSON.stringify(ds.styles.animation[2]) === '{"name":"Empty","entries":[],"key":"caskey_empty","id":"cas_empty"}');
  },
}, {
  name: "a runtime without getLocalCustomAnimationStylesAsync",
  async run() {
    // A runtime without getLocalCustomAnimationStylesAsync: an empty list, the rest of the catalog intact.
    const dsOld = await designSystem({ localStyles: { animation: null } });
    ok("no getLocalCustomAnimationStylesAsync (older runtime): styles.animation is [] and the other style kinds still export",
      Array.isArray(dsOld.styles.animation) && dsOld.styles.animation.length === 0 && dsOld.styles.grid.length === 1);
  },
}, {
  name: "collectDesignSystemOnly — the --design-system / figma_export_design_system path",
  async run() {
    const { api } = world();
    // No page/frame walk, no assets, just { designSystem }. Exercises the actual collector (not just buildDesignSystem
    // directly), since collectDesignSystemOnly is a claimRun()+useReads() wrapper around it.
    const dsOnly = await api.collectDesignSystemOnly();
    ok("collectDesignSystemOnly returns ONLY a designSystem (no layersDoc/assets keys)",
      !!dsOnly.designSystem && !("layersDoc" in dsOnly) && !("assets" in dsOnly));
    ok("collectDesignSystemOnly's designSystem carries the same variable/style/component data as buildDesignSystem",
      dsOnly.designSystem.variables.some((v) => v.name === "color/primary") &&
      Array.isArray(dsOnly.designSystem.styles.paint) && Array.isArray(dsOnly.designSystem.components));
    // The one documented gap (see collect.ts) is a consuming file's: its library (remote) variables are only the
    // ones it references. This mock DEFINES its tokens (no remote variable), so the line would be false
    // here and must be absent; the consuming case (one remote variable) is pinned in [ALIAS].
    ok("a file with no remote variable gets no 'consumes libraries' hygiene line (its catalog is its own)",
      !dsOnly.designSystem.variables.some((v) => v.remote === true) &&
      !dsOnly.designSystem.hygiene.some((h) => /library \(remote\) variables|consumes libraries|--as-library/.test(h)));
  },
}, {
  name: "Tier 1 read additions: component description, INSTANCE_SWAP preferredValues",
  async run() {
    const ds = await designSystem();
    const btnComp = ds.components.find((c) => c.name === "Button");
    ok("component description captured", !!(btnComp && btnComp.description === "Primary action button"));
    ok("INSTANCE_SWAP preferredValues captured", !!(btnComp && btnComp.props?.Icon && btnComp.props.Icon.type === "INSTANCE_SWAP" && Array.isArray(btnComp.props.Icon.preferredValues) && btnComp.props.Icon.preferredValues.length === 2));
  },
}, {
  name: "READ additions (HIGH tier + MED): collection default mode, variable description, document, component key and docs",
  async run() {
    const ds = await designSystem();
    const btnComp = ds.components.find((c) => c.name === "Button");
    ok("collection defaultModeId -> mode name", ds.collections.find((c) => c.name === "Semantic")?.default === "Light");
    ok("variable description captured", ds.variables.find((v) => v.name === "color/primary")?.description === "Primary brand color");
    ok("document color profile", ds.colorProfile === "display_p3");
    ok("document file name", ds.file === "My File");
    ok("component publish key captured", btnComp !== undefined && btnComp.key === "compkey123");
    const btnCompDoc0 = btnComp?.docs?.[0];
    ok("component documentationLinks captured", btnComp !== undefined && Array.isArray(btnComp.docs) && btnCompDoc0 !== undefined && btnCompDoc0 === "https://docs.example.com/button");
  },
}, {
  name: "text style leadingTrim / listSpacing / paragraphIndent and its variable binding",
  async run() {
    const ds = await designSystem();
    const bodyStyle = ds.styles.text.find((s) => s.name === "Body/Regular");
    ok("text style leadingTrim + listSpacing + paragraphIndent", !!(bodyStyle && bodyStyle.leadingTrim === "cap_height" && bodyStyle.listSpacing === 6 && bodyStyle.paragraphIndent === 4));
    ok("text style variable binding (fontSize -> token)", !!(bodyStyle && bodyStyle.tokens && bodyStyle.tokens.fontSize === "misc/bad"));
  },
}, {
  name: "catalog visuals: a component's radius is written as a page walk writes it (no sentinel, no float dust)",
  async run() {
    // A pill COMPONENT (Figma's "fully rounded" corner reads back as 1000000000), a COMPONENT whose radius
    // carries float dust from a resize, and a COMPONENT with one fully rounded corner among mixed corners.
    const pill = { type: "COMPONENT", name: "Pill", id: "pc:1", parent: null, width: 120, height: 32, cornerRadius: 1000000000, componentPropertyDefinitions: {} };
    const card = { type: "COMPONENT", name: "Card", id: "pc:2", parent: null, width: 200, height: 100, cornerRadius: 12.000000476837158, componentPropertyDefinitions: {} };
    const tab = { type: "COMPONENT", name: "Tab", id: "pc:3", parent: null, width: 80, height: 40, cornerRadius: MIXED,
      topLeftRadius: 1000000000, topRightRadius: 1000000000, bottomRightRadius: 4.0000001, bottomLeftRadius: 0, componentPropertyDefinitions: {} };
    const ds = await designSystem({ pages: [{ name: "Components", id: "p:c", children: [], findAllWithCriteria: () => [pill, card, tab] }] });
    const of = (name: string) => must(ds.components.find((c) => c.name === name), "catalog " + name).visuals;
    const pillV = of("Pill");
    ok("a pill component's radius is half its shorter side, not the 1000000000 sentinel", pillV?.radius === 16);
    ok("and the catalog says radiusFull, as the page walk does", pillV?.radiusFull === true);
    const cardV = of("Card");
    ok("a component's fractional radius is rounded to 2dp", cardV?.radius === 12);
    ok("an ordinary radius carries no radiusFull", cardV !== undefined && cardV.radiusFull === undefined);
    ok("mixed corners: fully rounded corners clamp to half the shorter side, the rest round, a zero corner is left out",
      JSON.stringify(of("Tab")) === '{"radiusFull":true,"radius":{"tl":20,"tr":20,"br":4}}');
  },
}];
