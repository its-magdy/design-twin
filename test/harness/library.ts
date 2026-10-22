// [LIB] team libraries — the half of the design system that lives in another file: the instance walk, the
// [VARIANTVIS] per-variant visuals, the registry attribution, listLibraries, the merge into the catalog — and
// [LIB-FILE], the export run inside the library file itself (--as-library).
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode, FakeTeamLibrary } from "../fake-figma.ts";
import { flatPaint, type Case } from "./helpers.ts";
import { world, type Fixtures } from "./scene.ts";

// ---- [LIB] team libraries: the half of the design system that lives in another file ----
// Every assertion here covers a shape the Plugin API really produces and that a naive implementation
// crashes on or lies about: a remote main whose `.parent` is NULL, a `componentPropertyDefinitions`
// getter that THROWS on a variant, and a teamLibrary that is absent (no permission) or empty
// (no library enabled — a NORMAL state, since libraries can only be turned on from the Figma UI).
// Optional fields are exercised at their DEFAULT, which is where the real bugs have always been.
//
// The page every [LIB] case reads: instances of two remote mains (one a variant whose definitions getter
// throws), one local main, and one whose main cannot be resolved; and the file's own button component.
function libPageOf(fx: Fixtures): FakeNode {
  const remoteVariantMain = {
    type: "COMPONENT", name: "Size=md, State=default", key: "libkey_btn", remote: true,
    parent: null, // documented shape for a remote main (plugin-api.d.ts:6092) — NOT a test convenience
    get componentPropertyDefinitions(): never {
      throw new Error("Can only get component property definitions of a component set or non-variant component");
    },
  };
  const remoteSetMain = {
    type: "COMPONENT", name: "Card", key: "libkey_card", remote: true, description: "Library card",
    parent: { type: "COMPONENT_SET", name: "CardSet" },
    componentPropertyDefinitions: { "Elevated#3:0": { type: "BOOLEAN", defaultValue: false }, "Tone": { type: "VARIANT", defaultValue: "a", variantOptions: ["a", "b"] } },
  };
  const localMain = { type: "COMPONENT", name: "LocalOnly", key: "compkey123", remote: false, parent: null, componentPropertyDefinitions: {} };
  const libInst = (main: FakeNode, props: Record<string, { type: string; value: string }>): FakeNode =>
    ({ type: "INSTANCE", name: "i", visible: true, componentProperties: props, getMainComponentAsync: async () => main });
  const libInstances: FakeNode[] = [
    libInst(remoteVariantMain, { "Size": { type: "VARIANT", value: "md" }, "Label#1:0": { type: "TEXT", value: "Go" } }),
    libInst(remoteVariantMain, { "Size": { type: "VARIANT", value: "lg" }, "Label#1:0": { type: "TEXT", value: "Stop" } }),
    libInst(remoteVariantMain, { "Size": { type: "VARIANT", value: "md" } }), // duplicate value must not duplicate the option
    libInst(remoteSetMain, { "Tone": { type: "VARIANT", value: "a" } }),
    libInst(localMain, { }),
    { type: "INSTANCE", name: "broken", visible: true, getMainComponentAsync: async () => { throw new Error("detached"); } },
  ];
  return { name: "Lib Page", id: "p:lib", loadAsync: async () => {}, children: [],
    // The catalog and the library scan ask for DIFFERENT types off the same page — answer each one
    // honestly so the merge below is exercised against a real local walk, not an empty one.
    findAllWithCriteria: ({ types }: { types: string[] }) => (types.indexOf("INSTANCE") !== -1 ? libInstances : [fx.buttonComponent]) };
}

// The enabled team library listLibraries and the catalog merge read: three collections of one library, one unreadable.
const acmeLibrary = (): FakeTeamLibrary => ({
  getAvailableLibraryVariableCollectionsAsync: async () => ([
    { name: "Semantic", key: "lc_sem", libraryName: "Acme DS" },
    { name: "Primitives", key: "lc_prim", libraryName: "Acme DS" },
    { name: "Broken", key: "lc_bad", libraryName: "Acme DS" },
  ]),
  getVariablesInLibraryCollectionAsync: async (k: string) => {
    if (k === "lc_bad") throw new Error("no access");
    return k === "lc_sem" ? [{ name: "a", key: "1", resolvedType: "COLOR" }, { name: "b", key: "2", resolvedType: "FLOAT" }] : [{ name: "c", key: "3", resolvedType: "COLOR" }];
  },
});

export const cases: Case[] = [{
  name: "[LIB] library components recovered by walking instances",
  async run() {
    const { api } = world((fx) => ({ pages: [libPageOf(fx)] }));
    const libComps = await api.collectLibraryComponents(() => {});
    ok("[LIB] library components recovered by walking instances (mains cannot be enumerated)", libComps.length === 2);
    const btnLib = libComps.find((c) => c.key === "libkey_btn");
    const cardLib = libComps.find((c) => c.key === "libkey_card");
    ok("[LIB] a LOCAL main is not duplicated into the library catalog", !libComps.some((c) => c.key === "compkey123"));
    ok("[LIB] an instance whose main cannot be resolved does not abort the scan", !!btnLib && !!cardLib);
    // Dedupe is by KEY, never by name: two libraries can both ship a "Button".
    ok("[LIB] deduped by publish key", !!btnLib && libComps.filter((c) => c.key === "libkey_btn").length === 1);
    const btnLibC = must(btnLib, "btnLib");
    const cardLibC = must(cardLib, "cardLib");
    ok("[LIB] and the instance count survives the dedupe", btnLibC.uses === 3);
    // parent === null is the documented remote shape — reading .parent.name would have thrown here.
    ok("[LIB] a NULL parent on a remote main is survivable, and its own name is used", btnLibC.name === "Size=md, State=default" && btnLibC.variant === undefined);
    ok("[LIB] a COMPONENT_SET parent gives the useful name, with the variant kept", cardLibC.name === "CardSet" && cardLibC.variant === "Card");
    // The getter THROWS on a variant — the fallback must engage, and must SAY it did.
    ok("[LIB] throwing componentPropertyDefinitions falls back to instances", btnLibC.derivedFrom === "instances");
    const btnProps = must(btnLibC.props, "btnLib.props");
    const btnSizeProp = must(btnProps.Size, "btnLib.props.Size");
    const btnSizeObserved = must(btnSizeProp.observed, "btnLib.props.Size.observed");
    ok("[LIB] observed variant values aggregated across instances", btnSizeObserved.indexOf("md") !== -1 && btnSizeObserved.indexOf("lg") !== -1);
    ok("[LIB] repeated values are uniqued, not appended per instance", btnSizeObserved.length === 2);
    ok("[LIB] non-variant props are observed too, keyed by the stripped name", !!(btnProps.Label && btnProps.Label.key === "Label#1:0"));
    // The whole point of derivedFrom: an inferred sample must never be mistaken for a complete enum.
    const cardProps = must(cardLibC.props, "cardLib.props");
    const cardToneProp = must(cardProps.Tone, "cardLib.props.Tone");
    ok("[LIB] readable definitions are used verbatim and flagged as such", cardLibC.derivedFrom === "definitions" && must(cardToneProp.options, "cardLib.props.Tone.options").length === 2);
    ok("[LIB] an inferred entry uses 'observed', a defined one uses 'options'", btnSizeProp.options === undefined && cardToneProp.observed === undefined);
    ok("[LIB] every entry is flagged remote", libComps.every((c) => c.remote === true));
    // There is NO API mapping a component key to its library — unattributed must read as unknown.
    ok("[LIB] unattributed remote components are 'unknown-library', never guessed", libComps.every((c) => c.source === "unknown-library"));
  },
}, {
  // ---- [VARIANTVIS] --variant-visuals: per-variant layout/fills truth, not the set-wrapper's chrome ----
  name: "[VARIANTVIS] --variant-visuals: per-variant layout/fills truth, not the set-wrapper's chrome",
  async run() {
    const variantA: FakeNode = {
      type: "COMPONENT", id: "v:a", name: "Type=Default, Status=Default", key: "vkey_a",
      fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0.6, b: 0 }, opacity: 1 }],
      cornerRadius: 16, visible: true, children: [],
    };
    const variantB: FakeNode = {
      type: "COMPONENT", id: "v:b", name: "Type=Default, Status=Hover", key: "vkey_b",
      variantProperties: { Type: "Default", Status: "Hover" },
      fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0.4, b: 0 }, opacity: 1 }],
      cornerRadius: 16, visible: true, children: [],
      // A variant whose own componentPropertyDefinitions getter throws (documented Plugin API shape) —
      // the walk must still emit this variant's node, just without props (props stay set-level only).
      get componentPropertyDefinitions(): never { throw new Error("Can only get component property definitions of a component set or non-variant component"); },
    };
    const tagSet = {
      type: "COMPONENT_SET", id: "set:tag", name: "Tag", key: "setkey_tag",
      fills: [{ type: "SOLID", visible: true, color: { r: 0.6, g: 0.28, b: 1 }, opacity: 1 }], // Figma's own purple selection chrome — NOT a design value
      cornerRadius: 5,
      componentPropertyDefinitions: { Type: { type: "VARIANT", variantOptions: ["Default"] }, Status: { type: "VARIANT", variantOptions: ["Default", "Hover"] } },
    };
    variantA.parent = tagSet; variantB.parent = tagSet;
    // A standalone COMPONENT — no COMPONENT_SET wrapper — must get the SAME serializeVariant treatment
    // under --variant-visuals, attached as entry.node rather than entry.variants[].node.
    const standaloneComp = {
      type: "COMPONENT", id: "c:solo", name: "IconButton", key: "compkey_solo", parent: null,
      fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 0, b: 0 }, opacity: 1 }],
      cornerRadius: 8, visible: true, children: [], componentPropertyDefinitions: {},
    };
    const variantPage = { name: "Variants", id: "p:variants", loadAsync: async () => {},
      findAllWithCriteria: ({ types }: { types: string[] }) => (types.indexOf("COMPONENT_SET") !== -1 ? [tagSet, variantA, variantB, standaloneComp] : []) };
    const { api } = world({ pages: [variantPage] });

    const dsOff = await api.collectDesignSystemOnly();
    const tagOff = dsOff.designSystem.components.find((c) => c.id === "set:tag");
    const soloOff = dsOff.designSystem.components.find((c) => c.id === "c:solo");
    ok("[VARIANTVIS] off by default: the set-wrapper's OWN visuals are what's captured (selection chrome, not design)", !!(tagOff && tagOff.visuals && flatPaint(must(tagOff.visuals.fills?.[0], "tagOff.visuals.fills[0]")).color === "#9947ff"));
    ok("[VARIANTVIS] off by default: no per-variant data attached", !!(tagOff && tagOff.variants === undefined));
    ok("[VARIANTVIS] off by default: a standalone COMPONENT gets no node tree either", !!(soloOff && soloOff.node === undefined));

    const dsOn = await api.collectDesignSystemOnly({ variantVisuals: true });
    const tagOn = dsOn.designSystem.components.find((c) => c.id === "set:tag");
    const soloOn = dsOn.designSystem.components.find((c) => c.id === "c:solo");
    ok("[VARIANTVIS] on: a standalone COMPONENT gets its own node tree under entry.node", !!(soloOn && soloOn.node && soloOn.node.fills && flatPaint(must(soloOn.node.fills[0], "soloOn.node.fills[0]")).color === "#ff0000" && soloOn.node.radius === 8));
    ok("[VARIANTVIS] on: a standalone COMPONENT never gets a variants[] array (that's the SET shape)", !!(soloOn && soloOn.variants === undefined));
    ok("[VARIANTVIS] on: the set entry itself is otherwise unchanged", !!(tagOn && tagOn.visuals && flatPaint(must(tagOn.visuals.fills?.[0], "tagOn.visuals.fills[0]")).color === "#9947ff"));
    ok("[VARIANTVIS] on: two variants captured, keyed by id/name/key", !!(tagOn && Array.isArray(tagOn.variants) && tagOn.variants.length === 2 &&
      tagOn.variants.every((v) => v.id && v.name && v.key)));
    const tagOnVariants = must(tagOn?.variants, "tagOn.variants");
    const va = tagOnVariants.find((v) => v.id === "v:a");
    const vb = tagOnVariants.find((v) => v.id === "v:b");
    ok("[VARIANTVIS] variant values parsed from the name when variantProperties is absent", !!(va && va.values && va.values.Type === "Default" && va.values.Status === "Default"));
    ok("[VARIANTVIS] variant values read from variantProperties when present", !!(vb && vb.values && vb.values.Status === "Hover"));
    ok("[VARIANTVIS] each variant's REAL fills/radius captured (the master-component source of truth)",!!(
      va && va.node && va.node.fills && flatPaint(must(va.node.fills[0], "va.node.fills[0]")).color === "#009900" && va.node.radius === 16));
    ok("[VARIANTVIS] a variant whose own componentPropertyDefinitions throws still gets its node captured, not dropped",!!(
      vb && vb.node && vb.node.fills && flatPaint(must(vb.node.fills[0], "vb.node.fills[0]")).color === "#006600"));
    ok("[VARIANTVIS] no per-variant props (componentPropertyDefinitions throws on a variant; set-level props stay authoritative)",!!(
      va && va.node && va.node.props === undefined));
  },
}, {
  // A user-maintained registry is the ONLY honest attribution route.
  name: "[LIB] the library registry attributes components",
  async run() {
    const registered = world((fx) => ({ pages: [libPageOf(fx)],
      rootPluginData: (k: string) => (k === "libraryRegistry" ? JSON.stringify({ libkey_btn: "Acme DS" }) : "") }));
    const attributed = await registered.api.collectLibraryComponents(() => {});
    ok("[LIB] the registry attributes a component to its library", attributed.find((c) => c.key === "libkey_btn")?.source === "Acme DS");
    ok("[LIB] and unregistered ones stay unknown", attributed.find((c) => c.key === "libkey_card")?.source === "unknown-library");
    const corrupt = world((fx) => ({ pages: [libPageOf(fx)], rootPluginData: () => "!!not json!!" }));
    const badReg = await corrupt.api.collectLibraryComponents(() => {});
    ok("[LIB] a corrupt registry degrades to no attribution, it does not throw", badReg.length === 2 && badReg.every((c) => c.source === "unknown-library"));
  },
}, {
  // --- listLibraries: the library discovery map ---
  name: "[LIB] listLibraries: the library discovery map",
  async run() {
    // DEFAULT state first: no figma.teamLibrary at all (permission missing / older host).
    const noPerm = await world((fx) => ({ pages: [libPageOf(fx)] })).api.listLibraries();
    ok("[LIB] a missing teamlibrary permission is a WARNING, not a crash", Array.isArray(noPerm.libraries) && noPerm.warnings.some((w) => /teamlibrary/.test(w)));
    ok("[LIB] and the component half still reports without it", noPerm.libraries.some((l) => l.componentCount === 2));
    ok("[LIB] the local file is listed as kind:local", noPerm.libraries.some((l) => l.kind === "local" && l.name === "My File"));
    ok("[LIB] local variable collections are counted", (noPerm.libraries.find((l) => l.kind === "local")?.variableCollections || []).some((c) => c.name === "Semantic" && c.variableCount === 3));
    ok("[LIB] the unknown-library bucket says counts are USED-IN-THIS-FILE, not what the library offers",
      /USED IN THIS FILE/.test(must(noPerm.libraries.find((l) => l.name === "unknown-library")?.note, "unknown-library note")));

    // Enabled-but-empty: a fresh file with no library turned on. NORMAL, and must say so.
    const empty = await world((fx) => ({ pages: [libPageOf(fx)],
      teamLibrary: { getAvailableLibraryVariableCollectionsAsync: async () => [], getVariablesInLibraryCollectionAsync: async () => [] } })).api.listLibraries();
    ok("[LIB] an empty team-library result reads as normal, not as a failure", empty.warnings.some((w) => /normal, not a failure/.test(w) && /Assets > Libraries/.test(w)));
    ok("[LIB] and it is not reported as an error", empty.libraries.length > 0);
    // The warning must SCOPE itself to variable collections. Worded as a flat "no libraries are
    // enabled" it contradicted the "LIBRARIES (2)" printed immediately below, whose rows come from the
    // component side and from this file itself — two true statements reading as one lie.
    ok("[LIB] and it says WHICH list is empty, so it cannot contradict the rows printed beneath it",
      empty.warnings.some((w) => /VARIABLE collections/.test(w) && /rows below come from this file itself/.test(w)));

    const libs = await world((fx) => ({ pages: [libPageOf(fx)], teamLibrary: acmeLibrary() })).api.listLibraries();
    const acme = libs.libraries.find((l) => l.name === "Acme DS");
    ok("[LIB] enabled libraries are grouped by libraryName (the ONLY name the API gives)", !!acme && acme.kind === "library" && acme.variableCollections.length === 3);
    const acmeC = must(acme, "acme");
    ok("[LIB] each collection carries its variable count", acmeC.variableCollections.find((c) => c.name === "Semantic")?.variableCount === 2);
    const brokenColl = must(acmeC.variableCollections.find((c) => c.name === "Broken"), "acme Broken collection");
    ok("[LIB] one unreadable collection omits only its own count", brokenColl.variableCount === undefined
      && libs.warnings.some((w) => /'Broken'/.test(w)));
    ok("[LIB] a library with no attributable components carries no invented count", acmeC.componentCount === undefined && /cannot be enumerated|impossible/.test(must(acmeC.note, "acme.note")));
  },
}, {
  // --- the merge into the design-system catalog ---
  name: "[LIB] the merge into the design-system catalog",
  async run() {
    const w = world((fx) => ({ pages: [libPageOf(fx)], teamLibrary: acmeLibrary() }));
    const dsLib = await w.api.buildDesignSystem();
    ok("[LIB] library components are merged into the design-system catalog", dsLib.components.some((c) => c.key === "libkey_btn" && c.remote === true));
    ok("[LIB] the local catalog walk still works alongside them", dsLib.components.some((c) => c.key === "compkey123" && !c.remote));
    ok("[LIB] a library main already present locally is not double-listed", dsLib.components.filter((c) => c.key === "compkey123").length === 1);
    ok("[LIB] hygiene warns that inferred props are a sample", dsLib.hygiene.some((h) => /published LIBRARY/.test(h) && /sample/.test(h)));
    // the "not the library's catalog" line also fires when the file consumes a library only through
    // COMPONENTS (no remote variable reaches the catalog); a local-only file (same page, no library instance) gets none.
    const dsRemoteComp = (await w.api.collectDesignSystemOnly()).designSystem;
    ok("consuming mock with only a remote component (no remote variable) gets the --as-library line",
      !dsRemoteComp.variables.some((v) => v.remote === true) && dsRemoteComp.components.some((c) => c.remote === true) &&
      dsRemoteComp.hygiene.some((h) => /--as-library/.test(h) && /not the library's catalog/.test(h)));
    const libPage = must(w.figma.root.children[0], "the lib page");
    const localOnlyPage = { ...libPage, findAllWithCriteria: ({ types }: { types: string[] }) => (types.indexOf("INSTANCE") !== -1 ? [] : [w.fx.buttonComponent]) };
    w.figma.root.children = [localOnlyPage];
    const dsLocalOnly = (await w.api.collectDesignSystemOnly()).designSystem;
    ok("a local-only mock (no remote variable, no remote component) gets no such line",
      !dsLocalOnly.variables.some((v) => v.remote === true) && !dsLocalOnly.components.some((c) => c.remote === true) &&
      !dsLocalOnly.hygiene.some((h) => /--as-library|consumes libraries/.test(h)));
  },
}, {
  // ---------- [LIB-FILE] the library-file export (--as-library) ----------
  // Run INSIDE the library file, everything is local, so the ordinary local reads return the COMPLETE
  // catalog — that is the whole reason this mode exists instead of importVariableByKeyAsync.
  name: "[LIB-FILE] the library-file export (--as-library)",
  async run() {
    const { api } = world();
    const lib = await api.collectLibraryFile({ asLibrary: "NIMA" });
    const d = lib.designSystem;

    ok("[LIB-FILE] stamps source.role=library", !!(d.source && d.source.role === "library"));
    const src = must(d.source, "d.source");
    ok("[LIB-FILE] carries the library name the user typed", src.libraryName === "NIMA");
    ok("[LIB-FILE] records fileKey as the durable directory identity", src.fileKey === "FILEKEY1234567");
    ok("[LIB-FILE] collectionKeys are the join back to --list-libraries", Array.isArray(src.collectionKeys));
    // exportedAt/file must stay top-level and unchanged — snapshot-meta.js and drift-lint read them.
    ok("[LIB-FILE] keeps the freshness stamp intact", typeof d.exportedAt === "string" && d.file === "My File");

    // Publish status: gated to library mode because Figma answers UNPUBLISHED for everything when
    // asked from a consuming file or a branch.
    const btn = d.components.find((c) => c.name === "Button");
    ok("[LIB-FILE] component carries publish status", !!(btn && btn.publish === "current"));
    const paint = must(d.styles.paint[0], "d.styles.paint[0]");
    ok("[LIB-FILE] style carries publish status", paint.publish === "changed");
    ok("[LIB-FILE] hygiene states the catalog is complete", d.hygiene.some((h) => /COMPLETE local catalog of 'NIMA'/.test(h)));
    ok("[LIB-FILE] hygiene admits the published snapshot is unlistable", d.hygiene.some((h) => /last PUBLISHED snapshot/.test(h)));
    ok("[LIB-FILE] does NOT claim the false design-system caveat", !d.hygiene.some((h) => /this file references — this is not the library's catalog/.test(h)));

    // The style fixes, which apply on BOTH paths — `key` is what makes a library style joinable at all.
    ok("[LIB-FILE] paint style carries its cross-file key", paint.key === "paintkey123");
    ok("[LIB-FILE] paint style carries bound variables (tokens)", !!(paint.tokens && Object.keys(paint.tokens).length > 0));
    ok("[LIB-FILE] paint style carries documentationLinks", Array.isArray(paint.docs) && paint.docs.length === 1);

    // The default path must NOT gain a publish field: it would read as authoritative and be wrong.
    const dsPlain = (await api.collectDesignSystemOnly({})).designSystem;
    ok("[LIB-FILE] default design-system pull emits NO publish status", !dsPlain.components.some((c) => c.publish) && !dsPlain.styles.paint.some((s) => s.publish));
    ok("[LIB-FILE] default design-system pull emits NO source block", dsPlain.source === undefined);
    ok("[LIB-FILE] but the style key fix applies there too", dsPlain.styles.paint[0]?.key === "paintkey123");
  },
}];
