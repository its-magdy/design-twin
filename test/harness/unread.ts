// [UNREAD] typed Figma fields the serializer reads: shader properties and propertyMetadata, complex strokes, SLOT
// slotSettings, per-run textWrapStyle — and [RUN-FIELDS], the per-run fontStyle / paragraph spacing / overrides.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import { MIXED, type FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

export const cases: Case[] = [{
  // ---------- [UNREAD] typed Figma fields: shader properties, complex strokes,
  // SLOT slotSettings, per-run textWrapStyle. Each: a node WITH the field -> exact IR; WITHOUT / at the
  // default -> the key is absent and the rest of the record is unaffected. ----------
  name: "[UNREAD] typed Figma fields: shader properties, complex strokes, SLOT slotSettings, per-run textWrapStyle",
  async run() {
    const w = world();
    const { api } = w;
    const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });
    const shape = (id: string, extra: Record<string, unknown>): FakeNode =>
      ({ type: "RECTANGLE", name: "Shape " + id, visible: true, id, width: 10, height: 10, ...extra });

    // 1a. ShaderPaint.properties — every ShaderPropertyValue member, bound values -> tokens.
    const shaderFill = await api.serialize(shape("un:1", { fills: [{ type: "SHADER", visible: true, id: "shd_wave", properties: {
      "p:bool": true, "p:text": "hello", "p:num": 0.12345, "p:rgb": { r: 1, g: 0, b: 0 }, "p:rgba": { r: 0, g: 0, b: 1, a: 0.5 },
      "p:point": { x: 0.333, y: 0.5 }, "p:line": { x: 0, y: 0, x2: 1, y2: 0.556 }, "p:circle": { x: 0.5, y: 0.5, radius: 0.25 },
      "p:cpoint": { x: 0.5, y: 0.5, radius: 0.25, angle: 45.678 }, "p:colorpt": { x: 0.1, y: 0.2, color: { r: 0, g: 1, b: 0 } },
      "p:colorptBound": { x: 0.1, y: 0.2, color: alias("v_primary") },
      "p:grad": { stops: [{ position: 0, color: { r: 1, g: 1, b: 1 } }, { position: 1, color: alias("v_blue600") }] },
      "p:bound": alias("v_allscope"),
    } }] }), 0, false);
    const shaderBare = await api.serialize(shape("un:2", { fills: [
      { type: "SHADER", visible: true, id: "shd_a" }, { type: "SHADER", visible: true, id: "shd_b", properties: {} }] }), 0, false);
    ok("[UNREAD] shader fill: properties normalised (hex / {color} / rounded points / stops), bound inputs named under tokens; " +
      "without properties / with an empty map: no properties, no tokens key (unchanged shape)",
      JSON.stringify(shaderBare.fills) === '[{"type":"shader","shaderId":"shd_a"},{"type":"shader","shaderId":"shd_b"}]' &&
      JSON.stringify(shaderFill.fills) === JSON.stringify([{ type: "shader", shaderId: "shd_wave", properties: {
        "p:bool": true, "p:text": "hello", "p:num": 0.12, "p:rgb": { color: "#ff0000" }, "p:rgba": { color: "#0000ff80" },
        "p:point": { x: 0.33, y: 0.5 }, "p:line": { x: 0, y: 0, x2: 1, y2: 0.56 }, "p:circle": { x: 0.5, y: 0.5, radius: 0.25 },
        "p:cpoint": { x: 0.5, y: 0.5, radius: 0.25, angle: 45.68 }, "p:colorpt": { x: 0.1, y: 0.2, color: "#00ff00" },
        "p:colorptBound": { x: 0.1, y: 0.2 }, "p:grad": { stops: [{ pos: 0, color: "#ffffff" }, { pos: 1 }] },
      }, tokens: { "p:colorptBound.color": "color/primary", "p:grad.stops.1.color": "blue/600", "p:bound": "misc/bad" } }]));

    // 1b. ShaderEffect.properties — same map, through the effects path.
    const shaderFx = await api.serialize(shape("un:3", { effects: [
      { type: "SHADER", visible: true, id: "shd_glow", properties: { "g:amt": 0.75, "g:tint": { r: 0, g: 0, b: 0, a: 0.25 }, "g:bound": alias("v_primary") } },
      { type: "SHADER", visible: true, id: "shd_plain" }] }), 0, false);
    ok("[UNREAD] shader effect: properties + token for the bound input; a shader effect without properties stays {type, shaderId}",
      JSON.stringify(shaderFx.effects) === JSON.stringify([
        { type: "shader", shaderId: "shd_glow", properties: { "g:amt": 0.75, "g:tint": { color: "#00000040" } }, tokens: { "g:bound": "color/primary" } },
        { type: "shader", shaderId: "shd_plain" }]));

    // 1c. propertyMetadata -> propertyDefs on a shader paint AND a shader effect: name, lowercased type, default
    // normalised like a value (hex / 2dp), a bound default named under tokens and an empty description dropped, a definition with
    // no assignment still listed; absent / empty / nameless metadata -> no propertyDefs key.
    const defsMeta = {
      "d:speed": { name: "Speed", type: "NUMBER", defaultValue: 0.12345, description: "Pulses per second" },
      "d:tint": { name: "Tint", type: "COLOR", defaultValue: { r: 1, g: 0, b: 0 }, description: "" },
      "d:origin": { name: "Origin", type: "CIRCLE_POINT", defaultValue: alias("v_primary") },
      "d:swap": { name: "Swap", type: "INSTANCE_SWAP" },
      "d:nameless": { type: "TEXT" },
    };
    const defsOut = {
      "d:speed": { name: "Speed", type: "number", default: 0.12, description: "Pulses per second" },
      "d:tint": { name: "Tint", type: "color", default: { color: "#ff0000" } },
      "d:origin": { name: "Origin", type: "circle_point", tokens: { default: "color/primary" } },
      "d:swap": { name: "Swap", type: "instance_swap" },
    };
    const defsFill = await api.serialize(shape("un:30", { fills: [
      { type: "SHADER", visible: true, id: "shd_d", properties: { "d:speed": 0.5 }, propertyMetadata: defsMeta },
      { type: "SHADER", visible: true, id: "shd_only", propertyMetadata: { "d:swap": defsMeta["d:swap"] } },
      { type: "SHADER", visible: true, id: "shd_empty", properties: { "d:speed": 1 }, propertyMetadata: {} }] }), 0, false);
    ok("[UNREAD] shader fill: propertyMetadata -> propertyDefs (lowercased type, default normalised, bound default named under tokens, empty description dropped, " +
      "unassigned definition kept, nameless entry skipped); metadata without properties -> propertyDefs only; empty metadata -> unchanged shape",
      JSON.stringify(defsFill.fills) === JSON.stringify([
        { type: "shader", shaderId: "shd_d", properties: { "d:speed": 0.5 }, propertyDefs: defsOut },
        { type: "shader", shaderId: "shd_only", propertyDefs: { "d:swap": { name: "Swap", type: "instance_swap" } } },
        { type: "shader", shaderId: "shd_empty", properties: { "d:speed": 1 } }]));
    const defsFx = await api.serialize(shape("un:31", { effects: [
      { type: "SHADER", visible: true, id: "shd_e", properties: { "d:speed": 0.5, "d:bound": alias("v_primary") }, propertyMetadata: defsMeta },
      { type: "SHADER", visible: true, id: "shd_e_only", propertyMetadata: { "d:swap": defsMeta["d:swap"] } },
      { type: "SHADER", visible: true, id: "shd_e_none", properties: { "d:speed": 1 } }] }), 0, false);
    ok("[UNREAD] shader effect: propertyMetadata -> propertyDefs next to properties and tokens; metadata alone -> propertyDefs only; none -> unchanged shape",
      JSON.stringify(defsFx.effects) === JSON.stringify([
        { type: "shader", shaderId: "shd_e", properties: { "d:speed": 0.5 }, propertyDefs: defsOut, tokens: { "d:bound": "color/primary" } },
        { type: "shader", shaderId: "shd_e_only", propertyDefs: { "d:swap": { name: "Swap", type: "instance_swap" } } },
        { type: "shader", shaderId: "shd_e_none", properties: { "d:speed": 1 } }]));

    // 1d. compound / bound / malformed DEFAULTS inside propertyDefs: the default is normalised like a value; a bound
    // default (or a bound colour inside one) is named under that definition's own tokens (default, default.color,
    // default.stops.N.color), never dropped silently; a null default and an unrecognised object are omitted
    // without failing the node.
    const cdefMeta = {
      "c:point": { name: "Point", type: "POINT", defaultValue: { x: 0.333, y: 0.5 } },
      "c:line": { name: "Line", type: "LINE", defaultValue: { x: 0, y: 0, x2: 1, y2: 0.556 } },
      "c:circle": { name: "Circle", type: "CIRCLE", defaultValue: { x: 0.5, y: 0.5, radius: 0.25 } },
      "c:colorpt": { name: "Colour point", type: "COLOR_POINT", defaultValue: { x: 0.1, y: 0.2, color: alias("v_primary") } },
      "c:colorptPlain": { name: "Plain colour point", type: "COLOR_POINT", defaultValue: { x: 0.1, y: 0.2, color: { r: 0, g: 1, b: 0 } } },
      "c:grad": { name: "Gradient", type: "GRADIENT", defaultValue: { stops: [{ position: 0, color: { r: 1, g: 1, b: 1 } }, { position: 1, color: alias("v_blue600") }] } },
      "c:bound": { name: "Bound", type: "NUMBER", defaultValue: alias("v_allscope") },
      "c:null": { name: "Null", type: "TEXT", defaultValue: null },
      "c:weird": { name: "Weird", type: "TEXT", defaultValue: { unexpected: 1 } },
    };
    const cdefOut = {
      "c:point": { name: "Point", type: "point", default: { x: 0.33, y: 0.5 } },
      "c:line": { name: "Line", type: "line", default: { x: 0, y: 0, x2: 1, y2: 0.56 } },
      "c:circle": { name: "Circle", type: "circle", default: { x: 0.5, y: 0.5, radius: 0.25 } },
      "c:colorpt": { name: "Colour point", type: "color_point", default: { x: 0.1, y: 0.2 }, tokens: { "default.color": "color/primary" } },
      "c:colorptPlain": { name: "Plain colour point", type: "color_point", default: { x: 0.1, y: 0.2, color: "#00ff00" } },
      "c:grad": { name: "Gradient", type: "gradient", default: { stops: [{ pos: 0, color: "#ffffff" }, { pos: 1 }] }, tokens: { "default.stops.1.color": "blue/600" } },
      "c:bound": { name: "Bound", type: "number", tokens: { default: "misc/bad" } },
      "c:null": { name: "Null", type: "text" },
      "c:weird": { name: "Weird", type: "text" },
    };
    const cdefFill = await api.serialize(shape("un:32", { fills: [
      { type: "SHADER", visible: true, id: "shd_c", propertyMetadata: cdefMeta }] }), 0, false);
    ok("[UNREAD] shader fill propertyDefs: point / line / circle defaults normalised; a bound colour point or gradient default keeps its " +
      "plain part and names the variable under the definition's tokens; a plain bound default has no default and tokens {default}; " +
      "a null default and an unrecognised object are omitted without throwing",
      JSON.stringify(cdefFill.fills) === JSON.stringify([{ type: "shader", shaderId: "shd_c", propertyDefs: cdefOut }]));
    const cdefProps = await api.serialize(shape("un:33", { fills: [
      { type: "SHADER", visible: true, id: "shd_p", properties: { "p:null": null, "p:weird": { unexpected: 1 }, "p:ok": 2 } }] }), 0, false);
    ok("[UNREAD] shader fill properties: a null value and an unrecognised object are omitted (no throw, no NaN colour); other values kept",
      JSON.stringify(cdefProps.fills) === JSON.stringify([{ type: "shader", shaderId: "shd_p", properties: { "p:ok": 2 } }]));

    // 2. complexStrokeProperties -> strokes.complex (BASIC = default -> absent).
    const stroked = (id: string, csp?: Record<string, unknown>) => api.serialize(shape(id, {
      strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], strokeWeight: 2, strokeAlign: "CENTER",
      ...(csp ? { complexStrokeProperties: csp } : {}) }), 0, false);
    const base = '{"colors":["#000000"],"weight":2,"align":"center"';
    const dyn = await stroked("un:4", { type: "DYNAMIC", frequency: 2.346, wiggle: 3, smoothen: 0.5 });
    const basic = await stroked("un:7", { type: "BASIC" });
    const noCsp = await stroked("un:8");
    ok("[UNREAD] dynamic stroke -> strokes.complex {type:dynamic, frequency, wiggle, smoothen}; BASIC and a node without " +
      "complexStrokeProperties: no complex key, strokes byte-identical",
      JSON.stringify(basic.strokes) === base + "}" && JSON.stringify(noCsp.strokes) === base + "}" &&
      JSON.stringify(dyn.strokes) === base + ',"complex":{"type":"dynamic","frequency":2.35,"wiggle":3,"smoothen":0.5}}');
    const scatter = await stroked("un:5", { type: "BRUSH", brushType: "SCATTER", brushName: "WITCH_HOUSE", gap: 0.25, wiggle: 0, sizeJitter: 1.5, angularJitter: -30, rotation: 90 });
    ok("[UNREAD] scatter brush -> strokes.complex with every scatter parameter, enums lowercased",
      JSON.stringify(scatter.strokes) === base + ',"complex":{"type":"brush","brushType":"scatter","brushName":"witch_house","gap":0.25,"wiggle":0,"sizeJitter":1.5,"angularJitter":-30,"rotation":90}}');
    const stretch = await stroked("un:6", { type: "BRUSH", brushType: "STRETCH", brushName: "NOIR", direction: "BACKWARD" });
    ok("[UNREAD] stretch brush -> strokes.complex {brushType:stretch, brushName, direction}",
      JSON.stringify(stretch.strokes) === base + ',"complex":{"type":"brush","brushType":"stretch","brushName":"noir","direction":"backward"}}');

    // 3. SLOT slotSettings on the component catalogue.
    const slotComp = { type: "COMPONENT", id: "c:panel", name: "Panel", key: "compkey_panel", parent: null, visible: true, children: [],
      componentPropertyDefinitions: {
        "Content#5:0": { type: "SLOT", defaultValue: "", description: "Body area",
          preferredValues: [{ type: "COMPONENT", key: "card_key" }],
          slotSettings: { minChildren: 1, maxChildren: null, allowPreferredValuesOnly: true, stretchChildOnInsert: false } },
        "Aside#5:1": { type: "SLOT", defaultValue: "", slotSettings: { minChildren: null, maxChildren: null } },
        "Footer#5:2": { type: "SLOT", defaultValue: "" },
        "Title#5:3": { type: "TEXT", defaultValue: "Hi", slotSettings: { minChildren: 2 } },
      } };
    const slotPage = { name: "Slots", id: "p:slots", loadAsync: async () => {},
      findAllWithCriteria: ({ types }: { types: string[] }) => (types.indexOf("COMPONENT") !== -1 ? [slotComp] : []) };
    w.figma.root.children = [slotPage];
    const slotDs = await api.collectDesignSystemOnly();
    const panelProps = slotDs.designSystem.components.find((c) => c.id === "c:panel")?.props;
    ok("[UNREAD] SLOT prop -> preferredValues (typings L9594: INSTANCE_SWAP and SLOT) + slotSettings as set (null max " +
      "omitted, false kept); a SLOT with only null limits / no slotSettings, and a non-SLOT prop carrying one: no slotSettings key",
      JSON.stringify(panelProps?.Content) === JSON.stringify({ key: "Content#5:0", type: "SLOT", default: "",
        preferredValues: [{ type: "COMPONENT", key: "card_key" }], description: "Body area",
        slotSettings: { stretchChildOnInsert: false, minChildren: 1, allowPreferredValuesOnly: true } }) &&
      JSON.stringify(panelProps?.Aside) === '{"key":"Aside#5:1","type":"SLOT","default":""}' &&
      JSON.stringify(panelProps?.Footer) === '{"key":"Footer#5:2","type":"SLOT","default":""}' &&
      JSON.stringify(panelProps?.Title) === '{"key":"Title#5:3","type":"TEXT","default":"Hi"}');

    // 4. Per-segment textWrapStyle. The fake honours the requested field list like the real API: a
    // segment only carries textWrapStyle when the extractor asked for it.
    type Seg = Record<string, unknown>;
    const segFont = { fontName: { family: "Inter", style: "Regular" }, fontSize: 14, fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }] };
    const wrapText = (id: string, nodeWrap: unknown, segs: Seg[]): FakeNode => ({
      type: "TEXT", name: "Copy", visible: true, id, width: 100, characters: segs.map((s) => String(s.characters)).join(""),
      fontName: { family: "Inter", style: "Regular" }, fontSize: 14, textWrapStyle: nodeWrap,
      getStyledTextSegments: (fields: string[]) => segs.map((s) => {
        const o: Seg = {};
        for (const [k, v] of Object.entries(s)) if (k !== "textWrapStyle" || fields.indexOf(k) !== -1) o[k] = v;
        return o;
      }),
    });
    const mixedWrap = await api.serialize(wrapText("un:9", MIXED, [
      { characters: "Intro\n", ...segFont, textWrapStyle: "AUTO" },
      { characters: "Balanced\n", ...segFont, textWrapStyle: "BALANCE" },
      { characters: "Pretty", ...segFont, textWrapStyle: "PRETTY" }]), 0, false);
    const uniformSegs = [{ characters: "One ", ...segFont, textWrapStyle: "BALANCE" },
      { characters: "Two", ...segFont, fontSize: 18, textWrapStyle: "BALANCE" }];
    const uniformWrap = await api.serialize(wrapText("un:10", "BALANCE", uniformSegs), 0, false);
    const uniformNoSegWrap = await api.serialize(wrapText("un:10", "BALANCE", uniformSegs.map(({ textWrapStyle: _w, ...s }) => s)), 0, false);
    ok("[UNREAD] node-level textWrapStyle mixed -> runs[].textWrap per segment (AUTO omitted), no font.textWrap; not mixed -> " +
      "no runs[].textWrap, node font.textWrap kept, output byte-identical to segments without the field",
      JSON.stringify((mixedWrap.runs || []).map((r) => r.textWrap === undefined ? null : r.textWrap)) === '[null,"balance","pretty"]' &&
      mixedWrap.font !== undefined && !("textWrap" in mixedWrap.font) &&
      (uniformWrap.runs || []).length === 2 && (uniformWrap.runs || []).every((r) => !("textWrap" in r)) &&
      uniformWrap.font !== undefined && uniformWrap.font.textWrap === "balance" &&
      JSON.stringify(uniformWrap) === JSON.stringify(uniformNoSegWrap));

    // 5. [RUN-FIELDS] per-run fontStyle / paragraphSpacing / paragraphIndent / textStyleOverrides
    // (StyledTextSegment, plugin-api.d.ts 1.139.0 L5496 / L5560 / L5564 / L5588). This fake honours the
    // requested field list for EVERY field, so a field the extractor forgot to request is simply absent.
    const segText = (id: string, node: Seg, segs: Seg[]): FakeNode => ({
      type: "TEXT", name: "Copy", visible: true, id, width: 100, characters: segs.map((s) => String(s.characters)).join(""),
      fontName: { family: "Inter", style: "Regular" }, fontSize: 14, ...node,
      getStyledTextSegments: (fields: string[]) => segs.map((s) => {
        const o: Seg = {};
        for (const [k, v] of Object.entries(s)) if (k === "characters" || fields.indexOf(k) !== -1) o[k] = v;
        return o;
      }),
    });
    const italicFont = { ...segFont, fontName: { family: "Inter", style: "Italic" } };
    const runSegs = (spacing: [number, number, number]): Seg[] => [
      { characters: "Intro\n", ...segFont, fontStyle: "REGULAR", paragraphSpacing: spacing[0], paragraphIndent: 4, textStyleId: "", textStyleOverrides: [] },
      { characters: "Emph\n", ...italicFont, fontStyle: "ITALIC", paragraphSpacing: spacing[1], paragraphIndent: 4, textStyleId: "s_heading",
        textStyleOverrides: [{ type: "SEMANTIC_ITALIC" }, { type: "HYPERLINK" }] },
      { characters: "Tail", ...segFont, fontStyle: "REGULAR", paragraphSpacing: spacing[2], paragraphIndent: 4, textStyleId: "",
        textStyleOverrides: [{ type: "TEXT_DECORATION" }] }];
    const mixedSpacing = await api.serialize(segText("rf:1", { paragraphSpacing: MIXED, paragraphIndent: 4 }, runSegs([0, 12, 16])), 0, false);
    const mRuns = mixedSpacing.runs || [];
    ok("[RUN-FIELDS] ITALIC segment -> run font.fontStyle \"italic\"; REGULAR runs have no fontStyle key",
      mRuns.length === 3 && mRuns[1]?.font.fontStyle === "italic" && !("fontStyle" in must(mRuns[0], "mRuns[0]").font) && !("fontStyle" in must(mRuns[2], "mRuns[2]").font));
    ok("[RUN-FIELDS] textStyleOverrides lower-cased on the styled run; dropped on a run with no textStyleId and when empty",
      JSON.stringify(mRuns[1]?.textStyleOverrides) === '["semantic_italic","hyperlink"]' &&
      !("textStyleOverrides" in must(mRuns[0], "mRuns[0]")) && !("textStyleOverrides" in must(mRuns[2], "mRuns[2]")));
    ok("[RUN-FIELDS] node paragraphSpacing mixed -> runs[].paragraphSpacing (0 omitted), no font.paragraphSpacing; uniform paragraphIndent stays node-level only",
      JSON.stringify(mRuns.map((r) => r.paragraphSpacing === undefined ? null : r.paragraphSpacing)) === "[null,12,16]" &&
      mRuns.every((r) => !("paragraphIndent" in r)) && mixedSpacing.font?.paragraphIndent === 4 &&
      mixedSpacing.font !== undefined && !("paragraphSpacing" in mixedSpacing.font));
    ok("[RUN-FIELDS] exact italic run shape (fontStyle after weight, style ref, spacing, overrides last)",
      JSON.stringify(mRuns[1]) === '{"text":"Emph\\n","font":{"size":14,"family":"Inter","weight":"Italic","fontStyle":"italic","color":"#000000"},' +
        '"textStyle":"Heading/H1","paragraphSpacing":12,"textStyleOverrides":["semantic_italic","hyperlink"]}');
    const indentMixed = await api.serialize(segText("rf:2", { paragraphSpacing: 8, paragraphIndent: MIXED }, runSegs([8, 8, 8]).map((s, i) => ({ ...s, paragraphIndent: [0, 6, 0][i] }))), 0, false);
    ok("[RUN-FIELDS] node paragraphIndent mixed -> runs[].paragraphIndent (0 omitted); uniform paragraphSpacing stays node-level only",
      JSON.stringify((indentMixed.runs || []).map((r) => r.paragraphIndent === undefined ? null : r.paragraphIndent)) === "[null,6,null]" &&
      (indentMixed.runs || []).every((r) => !("paragraphSpacing" in r)) && indentMixed.font?.paragraphSpacing === 8);
    // Uniform paragraph values: the runs must be exactly what segments WITHOUT the two paragraph fields give.
    const uniformSpacing = await api.serialize(segText("rf:3", { paragraphSpacing: 8, paragraphIndent: 4 }, runSegs([8, 8, 8])), 0, false);
    const uniformNoSpacing = await api.serialize(segText("rf:3", { paragraphSpacing: 8, paragraphIndent: 4 },
      runSegs([8, 8, 8]).map(({ paragraphSpacing: _s, paragraphIndent: _i, ...s }) => s)), 0, false);
    ok("[RUN-FIELDS] uniform paragraphSpacing/Indent -> no per-run keys, output byte-identical to segments without the fields",
      (uniformSpacing.runs || []).length === 3 && (uniformSpacing.runs || []).every((r) => !("paragraphSpacing" in r) && !("paragraphIndent" in r)) &&
      JSON.stringify(uniformSpacing) === JSON.stringify(uniformNoSpacing));
    // Single-run text: the lone segment's fontStyle lands on the node's `font` (where weightValue lives),
    // its overrides on the node itself; the bare-node fallback (no segment) has neither.
    const oneItalic = await api.serialize(segText("rf:4", {}, [{ characters: "Solo", ...italicFont, fontWeight: 400, fontStyle: "ITALIC",
      textStyleId: "s_heading", textStyleOverrides: [{ type: "SEMANTIC_WEIGHT" }] }]), 0, false);
    const noSeg = await api.serialize(segText("rf:5", {}, []), 0, false);
    ok("[RUN-FIELDS] single-run italic -> font.fontStyle \"italic\" beside weightValue, node textStyleOverrides [\"semantic_weight\"]; no segment -> neither key",
      oneItalic.runs === undefined && oneItalic.font?.fontStyle === "italic" && oneItalic.font.weightValue === 400 &&
      JSON.stringify(oneItalic.textStyleOverrides) === '["semantic_weight"]' &&
      noSeg.font !== undefined && !("fontStyle" in noSeg.font) && !("textStyleOverrides" in noSeg));
    // LIVE 2026-09-25: Figma Desktop returns textStyleOverrides as bare STRINGS (the docs page's own
    // example, developers.figma.com/docs/plugins/api/TextStyleOverrides/), not the `{ type }` objects
    // plugin-api.d.ts 1.139.0 L5465-5467 declares; `o.type.toLowerCase()` threw and killed the page
    // export. Strings, objects and a mix must all give the same output; a junk member is skipped.
    const asStrings = await api.serialize(segText("rf:4", {}, [{ characters: "Solo", ...italicFont, fontWeight: 400, fontStyle: "ITALIC",
      textStyleId: "s_heading", textStyleOverrides: ["SEMANTIC_WEIGHT"] }]), 0, false);
    const mixedShapes = await api.serialize(segText("rf:1", { paragraphSpacing: MIXED, paragraphIndent: 4 },
      runSegs([0, 12, 16]).map((s, i) => i === 1 ? { ...s, textStyleOverrides: ["SEMANTIC_ITALIC", { type: "HYPERLINK" }, 7, null, {}] } : s)), 0, false);
    ok("[RUN-FIELDS] textStyleOverrides as runtime STRINGS -> same output as the typings' {type} objects (single-run and per-run); junk members skipped",
      JSON.stringify(asStrings) === JSON.stringify(oneItalic) && JSON.stringify(mixedShapes) === JSON.stringify(mixedSpacing));
  },
}];
