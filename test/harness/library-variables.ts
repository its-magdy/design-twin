// LIBRARY (remote) variables, [ALIAS] chains into a library, alias hygiene, a library EASING variable reached only
// through a catalogued custom animation style, COMPOSED colour variables, and the collection KEY on every row.
// Each case states the whole library it resolves (`remote`) and the local variables it adds.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeCollection, FakeNode, FakeVariable } from "../fake-figma.ts";
import { aliasOf, composedOf, type Case } from "./helpers.ts";
import { world } from "./scene.ts";

// ---- the published library: one two-mode collection and the variables it holds
const LIB_COLLECTION = (): FakeCollection =>
  ({ id: "c_lib", name: "Library/Brand", modes: [{ modeId: "m_l", name: "Light" }, { modeId: "m_d", name: "Dark" }], defaultModeId: "m_l" });
const LIB_VAR = (): FakeVariable => ({ id: "v_lib", name: "brand/accent", resolvedType: "COLOR", variableCollectionId: "c_lib",
  scopes: ["FRAME_FILL"], codeSyntax: {}, remote: true, key: "libkey_accent",
  valuesByMode: { m_l: { r: 1, g: 0.4, b: 0, a: 1 }, m_d: { r: 1, g: 0.6, b: 0.2, a: 1 } } });
const LIB_MID = (): FakeVariable => ({ id: "v_libmid", name: "brand/mid", resolvedType: "COLOR", variableCollectionId: "c_lib",
  scopes: [], codeSyntax: {}, remote: true,
  valuesByMode: { m_l: { type: "VARIABLE_ALIAS", id: "v_libprim" }, m_d: { type: "VARIABLE_ALIAS", id: "v_libprim" } } });
const LIB_PRIM = (): FakeVariable => ({ id: "v_libprim", name: "brand/gray-100", resolvedType: "COLOR", variableCollectionId: "c_lib",
  scopes: [], codeSyntax: {}, remote: true,
  valuesByMode: { m_l: { r: 0.9, g: 0.9, b: 0.9, a: 1 }, m_d: { r: 0.2, g: 0.2, b: 0.2, a: 1 } } });
const LIB_EASE = (): FakeVariable => ({ id: "v_libease", name: "brand/ease-lib", resolvedType: "EASING", variableCollectionId: "c_lib",
  scopes: [], codeSyntax: {}, remote: true, valuesByMode: { m_l: { type: "EASE_IN" }, m_d: { type: "EASE_IN" } } });
const LIB_OP = (): FakeVariable => ({ id: "v_libop", name: "brand/opacity-60", resolvedType: "FLOAT", variableCollectionId: "c_lib",
  scopes: ["COLOR_OPACITY"], codeSyntax: {}, remote: true, valuesByMode: { m_l: 60, m_d: 40 } });
const LIB_INK = (): FakeVariable => ({ id: "v_libink", name: "brand/ink", resolvedType: "COLOR", variableCollectionId: "c_lib",
  scopes: [], codeSyntax: {}, remote: true, valuesByMode: { m_l: { r: 0, g: 0, b: 0, a: 1 }, m_d: { r: 1, g: 1, b: 1, a: 1 } } });
/** The library as a scene's `remote`: c_lib plus the given variables, resolvable by id and never listed locally. */
const library = (...vars: FakeVariable[]) => ({
  variables: Object.fromEntries(vars.map((v) => [v.id, v])),
  collections: { c_lib: LIB_COLLECTION() },
});
/** The library [ALIAS] resolves: brand/accent plus the two-hop alias chain. */
const aliasLibrary = (): FakeVariable[] => [LIB_MID(), LIB_PRIM(), LIB_VAR()];

const libNodeOf = (): FakeNode => ({ type: "FRAME", name: "LibCard", visible: true, id: "9:1", width: 100, height: 40,
  fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 0.4, b: 0 }, opacity: 1 }],
  boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "v_lib" }] } });

export const cases: Case[] = [{
  name: "LIBRARY (remote) variables",
  async run() {
    // ---- LIBRARY (remote) variables ----
    // getLocalVariablesAsync returns ONLY this file's variables, but node bindings resolve remote ones
    // by id. A file whose design system lives in a published library would otherwise emit screens full
    // of token names with no matching definitions, and the DTCG/CSS emitters would drop exactly the
    // tokens the screens use. The dump must pull referenced library variables in, flagged remote:true.
    // Resolvable by id (as the real API does for consumed library variables) but absent from the LOCAL list.
    const { api } = world({ remote: library(LIB_VAR()), selection: [libNodeOf()] });
    const libSel = await api.collectSelection({ css: false });
    const libDump = libSel.variables.variables.find((v) => v.name === "brand/accent");
    ok("library var referenced by a node IS included in the dump", !!libDump);
    ok("library var flagged remote:true", !!(libDump && libDump.remote === true));
    ok("library var values keyed by readable mode names", !!(libDump && libDump.values && libDump.values.Light === "#ff6600"));
    ok("library var's collection is emitted (default mode for :root)", libSel.variables.collections.some((c) => c.name === "Library/Brand" && c.default === "Light"));
    ok("library pull is reported in hygiene (never silent)", libSel.variables.hygiene.some((h) => /published LIBRARY/.test(h)));
    ok("node still resolves the library token by name", !!(libSel.screen.nodes[0]?.tokens && libSel.screen.nodes[0].tokens.fills === "brand/accent"));
    // An UNreferenced library variable must NOT be dragged in — the dump stays scoped to what's used.
    ok("unreferenced library vars are not pulled in", !libSel.variables.variables.some((v) => v.name === "unused/never"));
  },
}, {
  name: "[ALIAS] library variable reached ONLY through another variable's ALIAS",
  async run() {
    // ---- [ALIAS] library variable reached ONLY through another variable's ALIAS ----
    // Regression from the first real export (2026-07-28). varName.ids() is a SNAPSHOT of ids referenced
    // by NODES; a library primitive reached only via another variable's alias entered the memo cache
    // LATER (when values were resolved), so its NAME resolved — `aliasOf` showed a friendly name —
    // while the variable itself was dropped from variables[]. Downstream that is a dangling reference
    // (theming silently breaks) PLUS a false "broken alias … could not be resolved" hygiene line
    // accusing a healthy file. On the real file: 4 dangling refs, 0 genuinely broken.
    // Alias chains are multi-level, so this pins a TWO-hop chain that a single extra pass would miss:
    //   node -> v_semlib (local) -> v_libmid (library) -> v_libprim (library)
    const chainNode = { type: "FRAME", name: "ChainCard", visible: true, id: "9:2", width: 100, height: 40,
      fills: [{ type: "SOLID", visible: true, color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }],
      boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "v_semlib" }] } };
    const { api } = world({
      remote: library(...aliasLibrary()),
      // A LOCAL semantic token whose value aliases the library chain — neither library var is node-bound.
      variables: { v_semlib: { id: "v_semlib", name: "semantic/surface", resolvedType: "COLOR", variableCollectionId: "c_sem",
        scopes: ["FRAME_FILL"], codeSyntax: {}, remote: false,
        valuesByMode: { m_light: { type: "VARIABLE_ALIAS", id: "v_libmid" }, m_dark: { type: "VARIABLE_ALIAS", id: "v_libmid" } } } },
      selection: [chainNode],
    });
    const chainSel = await api.collectSelection({ css: false });
    const cv = (n: string) => chainSel.variables.variables.find((v) => v.name === n);

    ok("[ALIAS] hop 1 (aliased library var) is included", !!cv("brand/mid"));
    ok("[ALIAS] hop 2 (alias-of-an-alias) is ALSO included — fixed point, not one extra pass", !!cv("brand/gray-100"));
    const grayVar = cv("brand/gray-100");
    ok("[ALIAS] the pulled-in primitive carries its real VALUE, not just a name",
      !!grayVar && grayVar.values.Light === "#e6e6e6");
    const midVar = cv("brand/mid");
    ok("[ALIAS] the intermediate still reads as an alias", !!(!!midVar && midVar.values.Light &&
      aliasOf(midVar.values.Light) === "brand/gray-100"));
    // The false-accusation half: every alias target resolves, so hygiene must NOT claim otherwise.
    ok("[ALIAS] no FALSE 'broken alias' hygiene line for a chain that fully resolves",
      !chainSel.variables.hygiene.some((h) => /broken alias/.test(h)));
    // And the whole point: no emitted alias may point at a name that isn't in the dump.
    ok("[ALIAS] no alias dangles — every aliasOf target exists in variables[]", (() => {
      const names = new Set(chainSel.variables.variables.map((v) => v.name));
      for (const v of chainSel.variables.variables) {
        for (const val of Object.values(v.values || {})) {
          if (val && typeof val === "object" && "aliasOf" in val && val.aliasOf && !names.has(val.aliasOf)) return false;
        }
      }
      return true;
    })());
    // The same mock now CONSUMES a library (a local token aliases library variables): a design-system pull
    // carries the limitation in `hygiene` — the ONE field buildDesignSystemLayout's split persists to disk
    // (hygiene.json) and forwards through the MCP writeToDisk path, unlike a `manifest.warnings` field.
    const dsConsumer = await api.collectDesignSystemOnly();
    ok("collectDesignSystemOnly on a consuming file notes the library-variable limitation in hygiene (the field that survives to disk)",
      dsConsumer.designSystem.variables.some((v) => v.remote === true) && dsConsumer.designSystem.hygiene.some((h) => /library \(remote\) variables/.test(h)));
    // the line names the real remedy (--as-library) and no longer promises a page pull completes it.
    ok("design-system hygiene names --as-library and says it is not the library's catalog",
      dsConsumer.designSystem.hygiene.some((h) => /--as-library/.test(h) && /not the library's catalog/.test(h)));
    ok("and does not say a page pull gives the full set",
      !dsConsumer.designSystem.hygiene.some((h) => /pull a page for the full set|prior\/no page walk/.test(h)));
  },
}, {
  name: "alias hygiene: a resolved library alias vs a dangling one",
  async run() {
    // Alias hygiene must distinguish "points at a library variable we resolved" from "genuinely
    // dangling". The check keyed off the LOCAL id set alone, so every legitimate library alias was
    // reported as broken — on a library-consuming file that is the whole hygiene list, and real
    // breakage hides among the noise.
    // The same library as [ALIAS], without its local semantic/surface token.
    const { api } = world({
      remote: library(...aliasLibrary()),
      variables: {
        v_aliases_lib: { id: "v_aliases_lib", name: "color/brand", resolvedType: "COLOR", variableCollectionId: "c_sem",
          scopes: ["FRAME_FILL"], codeSyntax: {}, remote: false, valuesByMode: { m_light: { type: "VARIABLE_ALIAS", id: "v_lib" } } },
        v_dangling: { id: "v_dangling", name: "color/ghost", resolvedType: "COLOR", variableCollectionId: "c_sem",
          scopes: ["FRAME_FILL"], codeSyntax: {}, remote: false, valuesByMode: { m_light: { type: "VARIABLE_ALIAS", id: "v_deleted" } } },
      },
      selection: [libNodeOf()],
    });
    const aliasSel = await api.collectSelection({ css: false });
    const aliasHyg = aliasSel.variables.hygiene;
    // Matched loosely on purpose: a regex tied to one exact phrasing would pass against a different,
    // broken behaviour too and prove nothing.
    ok("alias to a RESOLVED library variable is not called broken", !aliasHyg.some((h) => /broken.*'color\/brand'/.test(h)));
    ok("alias to a resolved library var still resolves to its name", aliasSel.variables.variables.some((v) => v.name === "color/brand" && v.values.Light && aliasOf(v.values.Light) === "brand/accent"));
    ok("a genuinely dangling alias IS still reported", aliasHyg.some((h) => /broken alias in 'color\/ghost'/.test(h)));
    ok("dangling-alias warning names the unresolved id", aliasHyg.some((h) => /v_deleted/.test(h)));
  },
}, {
  name: "a library EASING variable referenced ONLY by a catalogued custom animation style",
  async run() {
    // ---- a library EASING variable referenced ONLY by a catalogued custom animation style ----
    // buildDesignSystem resolves the animation styles BEFORE dumpVariables: resolving an entry's props records
    // the variable ids it binds, and dumpVariables pulls the referenced library variables in from that record.
    // The style below is catalog-only (no node applies it) and binds a non-local variable nothing else
    // references, so the variable reaches the dump only if the animation build ran first.
    const easeOnlyStyle: FakeNode = {
      type: "CUSTOM_ANIMATION", id: "cas_ease", key: "caskey_ease", name: "Library Ease", description: "",
      remote: false, documentationLinks: [], getPublishStatusAsync: async () => "CURRENT",
      animationEntries: [{ type: "FIGMA", id: "entry_ease", styleId: "as3", name: "Fade", duration: 0.2,
        props: { easing: { type: "VARIABLE_ALIAS", id: "v_libease" } } }],
    };
    const { api } = world({ remote: library(...aliasLibrary(), LIB_EASE()), localStyles: { animation: [easeOnlyStyle] } });
    const dsEase = await api.buildDesignSystem();
    const easeVar = dsEase.variables.find((v) => v.name === "brand/ease-lib");
    ok("a library EASING variable referenced only by a catalogued custom animation style entry is pulled into the exported variables",
      !!easeVar && easeVar.remote === true && JSON.stringify(dsEase.styles.animation[0]?.entries?.[0]?.props) === '{"easing":{"aliasOf":"brand/ease-lib"}}');
  },
}, {
  name: "COMPOSED colour variables",
  async run() {
    // ---- COMPOSED colour variables (plugin-typings 1.139, Figma Update 139) ----
    // VariableComposedColor = {color: RGB|RGBA, opacity: VariableAlias} | {color: VariableAlias, opacity: number|VariableAlias}.
    // Its nested alias(es) must be treated like a top-level alias: resolved to a name in the IR, pulled
    // in from the library when only the composed value references them, counted for the tier and the
    // "raw value in a multi-mode collection" hygiene check, and reported when they dangle.
    const { api } = world({
      remote: library(...aliasLibrary(), LIB_OP(), LIB_INK()),
      variables: {
        // form 1: raw colour + opacity alias, in BOTH modes of a two-mode collection
        v_comp_raw: { id: "v_comp_raw", name: "overlay/scrim", resolvedType: "COLOR", variableCollectionId: "c_sem",
          scopes: ["FRAME_FILL"], codeSyntax: {}, remote: false, valuesByMode: {
            m_light: { color: { r: 0, g: 0, b: 0, a: 1 }, opacity: { type: "VARIABLE_ALIAS", id: "v_libop" } },
            m_dark: { color: { r: 1, g: 1, b: 1 }, opacity: { type: "VARIABLE_ALIAS", id: "v_libop" } } } },
        // form 2: colour alias + raw opacity (Light) / colour alias + opacity alias (Dark)
        v_comp_alias: { id: "v_comp_alias", name: "text/muted", resolvedType: "COLOR", variableCollectionId: "c_sem",
          scopes: [], codeSyntax: {}, remote: false, valuesByMode: {
            m_light: { color: { type: "VARIABLE_ALIAS", id: "v_libink" }, opacity: 50 },
            m_dark: { color: { type: "VARIABLE_ALIAS", id: "v_libink" }, opacity: { type: "VARIABLE_ALIAS", id: "v_libop" } } } },
        // a composed colour whose opacity alias dangles
        v_comp_ghost: { id: "v_comp_ghost", name: "text/ghost", resolvedType: "COLOR", variableCollectionId: "c_sem",
          scopes: ["TEXT_FILL"], codeSyntax: {}, remote: false, valuesByMode: {
            m_light: { color: { type: "VARIABLE_ALIAS", id: "v_libink" }, opacity: { type: "VARIABLE_ALIAS", id: "v_gone" } } } },
        // form 3: the UNDOCUMENTED runtime shape (figma/plugin-typings issue #375): Light = text/muted's Light,
        // Dark = overlay/scrim's Light, each spelled as a COMPOSE_COLOR expression. Must read as the documented form.
        v_comp_expr: { id: "v_comp_expr", name: "text/expr", resolvedType: "COLOR", variableCollectionId: "c_sem",
          scopes: [], codeSyntax: {}, remote: false, valuesByMode: {
            m_light: { type: "VARIABLE_EXPRESSION", expressionFunction: "COMPOSE_COLOR", expressionArguments: [{ type: "VARIABLE_ALIAS", id: "v_libink" }, 50] },
            m_dark: { type: "VARIABLE_EXPRESSION", expressionFunction: "COMPOSE_COLOR", expressionArguments: [{ r: 0, g: 0, b: 0, a: 1 }, { type: "VARIABLE_ALIAS", id: "v_libop" }] } } },
      },
      selection: [libNodeOf()],
    });
    const compSel = await api.collectSelection({ css: false });
    const compVar = (n: string) => compSel.variables.variables.find((v) => v.name === n);
    const scrim = compVar("overlay/scrim"), muted = compVar("text/muted");
    const scrimL = composedOf(scrim && scrim.values.Light), scrimD = composedOf(scrim && scrim.values.Dark);
    const mutedL = composedOf(muted && muted.values.Light), mutedD = composedOf(muted && muted.values.Dark);
    ok("[composed] raw colour + opacity alias -> {composed:{color:hex, opacity:{aliasOf}}}",
      JSON.stringify(scrim && scrim.values.Light) === JSON.stringify({ composed: { color: "#000000", opacity: { aliasOf: "brand/opacity-60" } } }));
    ok("[composed] a raw RGB (no alpha) colour half folds to 6-digit hex like any COLOR value", !!scrimD && scrimD.color === "#ffffff");
    ok("[composed] colour alias + raw opacity -> {composed:{color:{aliasOf}, opacity:<number verbatim>}}",
      JSON.stringify(muted && muted.values.Light) === JSON.stringify({ composed: { color: { aliasOf: "brand/ink" }, opacity: 50 } }));
    ok("[composed] both halves aliases -> both resolved to names",
      !!mutedD && typeof mutedD.color === "object" && mutedD.color.aliasOf === "brand/ink" && typeof mutedD.opacity === "object" && mutedD.opacity.aliasOf === "brand/opacity-60");
    ok("[composed] every mode of both composed variables is emitted composed", !!scrimL && !!scrimD && !!mutedL && !!mutedD);
    const expr = compVar("text/expr");
    ok("[composed] the COMPOSE_COLOR expression shape (issue #375) reads EXACTLY as the documented {color, opacity} shape",
      !!expr && !!mutedL && !!scrimL && JSON.stringify(expr.values.Light) === JSON.stringify(must(muted, "muted").values.Light) &&
      JSON.stringify(expr.values.Dark) === JSON.stringify(must(scrim, "scrim").values.Light) && composedOf(expr.values.Light) !== undefined);
    const libOp = compVar("brand/opacity-60"), libInk = compVar("brand/ink");
    ok("[composed] library var reached ONLY via a nested OPACITY alias is pulled in (aliasTargets)",
      !!libOp && libOp.remote === true && libOp.values.Light === 60);
    ok("[composed] library var reached ONLY via a nested COLOR alias is pulled in (aliasTargets)",
      !!libInk && libInk.values.Light === "#000000");
    ok("[composed] COLOR_OPACITY scope carried through verbatim", !!libOp && (libOp.scopes || []).includes("COLOR_OPACITY"));
    ok("[composed] a composed value counts as an alias for the tier (semantic even when unscoped)", !!muted && muted.tier === "semantic");
    ok("[composed] no 'raw value in a multi-mode collection' hygiene line for a composed colour",
      !compSel.variables.hygiene.some((h) => /semantic color '(overlay\/scrim|text\/muted)'/.test(h)));
    ok("[composed] resolved nested aliases are not called broken", !compSel.variables.hygiene.some((h) => /broken alias in '(overlay\/scrim|text\/muted)'/.test(h)));
    ok("[composed] a dangling NESTED alias is reported with its id", compSel.variables.hygiene.some((h) => /broken alias in 'text\/ghost'.*v_gone/.test(h)));
  },
}, {
  name: "every variable row carries its collection's KEY",
  async run() {
    // ---- every variable row carries its collection's KEY: collection names repeat ----
    // Two local collections both named "Spacing" (keys K1/K2) plus a library one also named "Spacing" reached
    // through a remote variable: the name cannot tell the rows apart, `collectionKey` can. A collection whose
    // key is not a non-empty string (the typings promise it only on local and published collections) -> omitted.
    const nmMode = [{ modeId: "nm_m", name: "Value" }];
    const nmColls: FakeCollection[] = [
      { id: "nm_c1", name: "Spacing", key: "K1", modes: nmMode, defaultModeId: "nm_m" },
      { id: "nm_c2", name: "Spacing", key: "K2", modes: nmMode, defaultModeId: "nm_m" },
      { id: "nm_c4", name: "Radius", key: "", modes: nmMode, defaultModeId: "nm_m" },
      { id: "nm_c5", name: "Sizing", key: 42, modes: nmMode, defaultModeId: "nm_m" },
      { id: "nm_c6", name: "Motion", key: { id: "K6" }, modes: nmMode, defaultModeId: "nm_m" },
    ];
    const nmRemoteColl: FakeCollection = { id: "nm_c3", name: "Spacing", key: "K3", modes: nmMode, defaultModeId: "nm_m" };
    const nmVar = (id: string, cid: string, remote = false): FakeVariable => ({ id, name: "space/4", resolvedType: "FLOAT", variableCollectionId: cid,
      scopes: ["GAP"], codeSyntax: {}, remote, valuesByMode: { nm_m: 4 } });
    const nmLocal = [nmVar("nm_v1", "nm_c1"), nmVar("nm_v2", "nm_c2"), { ...nmVar("nm_v4", "nm_c4"), name: "radius/2" },
      { ...nmVar("nm_v5", "nm_c5"), name: "size/2" }, { ...nmVar("nm_v6", "nm_c6"), name: "motion/2" }];
    const nmRemote = nmVar("nm_v3", "nm_c3", true);
    // This file has these variables and none of the base file's, so all four lookups are replaced (a scene only adds).
    const { api } = world({
      selection: [{ type: "FRAME", name: "Gap", visible: true, id: "nm:1", width: 10, height: 10, layoutMode: "HORIZONTAL",
        itemSpacing: 4, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, boundVariables: { itemSpacing: { type: "VARIABLE_ALIAS", id: "nm_v3" } }, children: [] }],
    }, { variables: {
      getLocalVariablesAsync: async () => nmLocal,
      getLocalVariableCollectionsAsync: async () => nmColls,
      getVariableByIdAsync: async (id: string) => (id === "nm_v3" ? nmRemote : nmLocal.find((v) => v.id === id) || null),
      getVariableCollectionByIdAsync: async (id: string) => (id === "nm_c3" ? nmRemoteColl : nmColls.find((c) => c.id === id) || null),
    } });
    const nmSel = await api.collectSelection({ css: false });
    const spacingRows = nmSel.variables.variables.filter((v) => v.collection === "Spacing");
    ok("three 'Spacing' rows (two local, one library), each with its own collection's key",
      spacingRows.length === 3 && JSON.stringify(spacingRows.map((r) => r.collectionKey).sort()) === '["K1","K2","K3"]' &&
      spacingRows.find((r) => r.remote)?.collectionKey === "K3");
    ok("a collection whose key is empty, a number or an object gives its rows no collectionKey", (() => {
      const rows = ["radius/2", "size/2", "motion/2"].map((n) => nmSel.variables.variables.find((v) => v.name === n));
      return rows.every((r) => !!r && !("collectionKey" in r)) && rows.map((r) => r?.collection).join() === "Radius,Sizing,Motion";
    })());
  },
}];
