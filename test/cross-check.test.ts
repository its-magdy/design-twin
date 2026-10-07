// Offline tests for design-to-code/cross-check.ts — the JOIN between a screen and the design system.
//
// Every fixture here is a miniature of a defect the live run hit by hand and the tooling missed:
// a duplicated file that re-keys every collection, a catalog that covers 0% of the screen, two
// libraries whose token names collide on different values, a text style that differs by one capital
// letter, a radius of a billion, a Dark-only export of a two-mode system.
// Run with:  node test/cross-check.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { crossCheck, toMarkdown, composedRgba } from "../design-to-code/cross-check.ts";
import { audit } from "../design-to-code/audit.ts";
import { parseHex, clampOpacityPct, composeAlpha, formatHex, compositeOver } from "../design-to-code/color.ts";
import { screenCoverage } from "../design-to-code/drift-lint.ts";
import { check as ok, report } from "./assert.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { catalog, codeMap, must, node, parseAs, readFixture, screenExport, tokens } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { isScreenExport } from "../design-to-code/export-shape.ts";
import { isComponentsCatalog, isTokensDoc } from "../design-to-code/doc-guards.ts";
import type { DocGuard } from "../design-to-code/doc-guards.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import { findingIds } from "../design-to-code/finding-id.ts";
import { matchByNameAndSignature, nameVerdict, visibleInstances } from "../design-to-code/component-match.ts";
// cross-check --json: the report; only summary/findings/coverage/componentProposals are read here.
const isCrossCheckReport = (x: unknown): x is CrossCheckReport => isJsonObject(x) && Array.isArray(x.findings) && isJsonObject(x.summary);
import type { CrossCheckScreen } from "../design-to-code/cross-check.ts";
import type {
  ComponentPropValues, CoverageBucket, CrossCheckCoverage, CrossCheckFinding, CrossCheckFindingCode,
  CrossCheckReport, IrNode, TextStylesDoc,
} from "../design-to-code/types.ts";

type Findings = { findings: CrossCheckFinding[] };
const has = (res: Findings, code: CrossCheckFindingCode) => res.findings.some((f) => f.code === code);
// Every caller reads a property straight off the finding (a missing one throws, as the JS did); `sev`
// is the one read that tolerates absence.
const get = (res: Findings, code: CrossCheckFindingCode) => must(res.findings.find((f) => f.code === code), `a ${code} finding`);
const sev = (res: Findings, code: CrossCheckFindingCode) => res.findings.find((f) => f.code === code)?.severity;

// ---------------------------------------------------------------- fixtures
const instance = (id: string, setKey: string, setName: string, props?: ComponentPropValues): NodeInput => ({
  type: "INSTANCE", id, name: setName, props: props || {},
  mainComponent: { name: setName, key: setKey + "-v", setKey, setName },
});
const text = (id: string, family: string, style?: string | null, token?: string): NodeInput => ({
  type: "TEXT", id, text: "", font: { family, size: 14 }, ...(style ? { styles: { text: style } } : {}),
  ...(token ? { tokens: { fills: token } } : {}),
});
const screen = (label: string, children?: NodeInput[]): CrossCheckScreen => ({
  doc: screenExport([{ type: "FRAME", id: "1:1", resolvedModes: { Sem: "Dark" }, ...(children ? { children } : {}) }], { exportedAt: "2026-09-22T00:00:00Z", screen: label }),
  label,
});

const DS_TOKENS = tokens({
  collections: [
    { name: "Sem", key: "ds-sem", modes: ["Dark", "Light"], default: "Dark" },
    { name: "Spacing", key: "ds-space", modes: ["Mode 1"], default: "Mode 1" },
  ],
  variables: [
    { name: "Text/Main", collection: "Sem", key: "ds-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } },
    { name: "Space 3", collection: "Spacing", key: "ds-k2", type: "FLOAT", values: { "Mode 1": 16 } },
    { name: "Full", collection: "Spacing", key: "ds-k3", type: "FLOAT", values: { "Mode 1": 1000000000 } },
  ],
});
const DS_COMPONENTS = catalog([
  // DT-27: a plain COMPONENT, so an instance with no variant and a `Btn Text` prop agrees on signature (a
  // COMPONENT_SET would need the instance to set a variant — component-match's rule, now cross-check's too)
  { name: "Button", key: "ds-btn", type: "COMPONENT", props: { "Btn Text": { type: "TEXT" } } },
  { name: "Header", key: "ds-hdr", type: "COMPONENT_SET", props: {} },
  { name: "Header", key: "ds-hdr2", type: "COMPONENT_SET", props: {} },
]);
const DS_TEXT_STYLES: TextStylesDoc = { styles: [{ name: "Medium/14 medium", font: "Poppins", size: 14 }] };

// ---------------------------------------------------------------- a duplicated file re-keys everything
console.log("cross-check — the screen's token library vs the design system's:");
{
  // Same collection NAME, same values, different key: the signature of "(Copy)".
  const duplicated = tokens({
    collections: [{ name: "Sem", key: "screen-sem", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [{ name: "Text/Main", collection: "Sem", key: "screen-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } }],
  });
  const res = crossCheck({ screens: [screen("S", [text("2:1", "Poppins", null, "Text/Main")])], variables: duplicated, tokens: DS_TOKENS });
  // D11: a warning to CONFIRM (the default is the screen's own values), no longer a blocker.
  ok("[tokens/D11] a screen whose collections are ALL re-keyed is a warning with a confirm question (was: a blocker)",
    sev(res, "foreign-token-library") === "warning" && /None of the screen's variable collections/.test(get(res, "foreign-token-library").confirm ?? ""));
  const partial = crossCheck({ screens: [screen("S", [])], variables: tokens({ collections: [...(duplicated.collections ?? []), { name: "Sem", key: "ds-sem", modes: ["Dark", "Light"], default: "Dark" }], variables: [] }), tokens: DS_TOKENS });
  const n = (partial.findings.find((f) => f.code === "foreign-token-library")?.collections ?? []).length;
  ok("[review M2] a partial foreign library's confirm question counts the collections that ARE in the design system",
    /^Only 1 of \d+ of the screen's variable collections are in the design system/.test(get(partial, "foreign-token-library").confirm ?? "") && n >= 1);
  ok("[F-19] the hint names the MCP twin of `dtwin list libraries`, and says the library export is CLI only",
    /figma_list_libraries/.test(get(res, "foreign-token-library").message) && /CLI only/.test(get(res, "foreign-token-library").message));
  ok("[tokens] and the message names the duplicated-file cause rather than just 'not found'",
    /DUPLICATED Figma file/.test(get(res, "foreign-token-library").message));
  ok("[tokens] it names the ONE command that can attribute a collection to a library",
    /list libraries/.test(get(res, "foreign-token-library").message));
  ok("[tokens] identical values under a different key are NOT reported as a value conflict",
    !has(res, "token-name-collision"));
}
{
  const same = tokens({
    collections: [{ name: "Sem", key: "ds-sem", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [{ name: "Text/Main", collection: "Sem", key: "ds-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } }],
  });
  const res = crossCheck({ screens: [screen("S", [])], variables: same, tokens: DS_TOKENS });
  ok("[tokens] a screen that really does use the design system's collections says so",
    has(res, "token-library-matches") && !has(res, "foreign-token-library"));
}

// ---------------------------------------------------------------- DT-07: offline name reconciliation
console.log("cross-check — DT-07: the foreign-library finding classifies the screen's variables by name:");
{
  const FOREIGN_COLL = [{ name: "Sem", key: "screen-sem", modes: ["Dark", "Light"], default: "Dark" }];
  const dup = tokens({
    collections: FOREIGN_COLL,
    variables: [{ name: "Text/Main", collection: "Sem", key: "screen-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } }],
  });
  const res = crossCheck({ screens: [screen("S", [text("2:1", "Poppins", null, "Text/Main")])], variables: dup, tokens: DS_TOKENS });
  const f = get(res, "foreign-token-library");
  const offline = f.message.indexOf("Offline check"), live = f.message.indexOf("list libraries");
  ok("[DT07-1] the message carries the offline counts BEFORE the live advice",
    offline > 0 && live > offline && /Only to find the owning file: run/.test(f.message));
  ok("[DT07-1] counts: 1 variable, 1 agrees, 0 differ / undecidable / absent, and says mapping by NAME is safe",
    /of the 1 variables in those collections, 1 have a design-system variable of the same name resolving the same in every shared mode, 0 resolve differently \(listed as token-name-collision\), 0 cannot be compared \(no shared mode\), 0 have no same-name variable/.test(f.message) && /Mapping by NAME is safe for the 1/.test(f.message));
  ok("[DT07-1] extras: nameMap {agree:1, differ:0, undecidable:0, absent:0}; severity and collections unchanged",
    JSON.stringify(f.nameMap) === JSON.stringify({ agree: 1, differ: 0, undecidable: 0, absent: 0 }) && f.severity === "warning" && (f.collections ?? []).length === 1);

  // a re-keyed twin with a different value: differ 1 + a token-name-collision finding, no "safe" sentence
  const diff = tokens({
    collections: FOREIGN_COLL,
    variables: [{ name: "Text/Main", collection: "Sem", key: "screen-k1", type: "COLOR", values: { Dark: "#fff", Light: "#111" } }],
  });
  const rd = crossCheck({ screens: [screen("S", [text("2:1", "Poppins", null, "Text/Main")])], variables: diff, tokens: DS_TOKENS });
  const fd = get(rd, "foreign-token-library");
  ok("[DT07-2] a re-keyed twin with a different value: differ 1 (and listed as token-name-collision), no 'safe' claim",
    JSON.stringify(fd.nameMap) === JSON.stringify({ agree: 0, differ: 1, undecidable: 0, absent: 0 }) && has(rd, "token-name-collision") && !/Mapping by NAME is safe/.test(fd.message) && /1 resolve differently/.test(fd.message));

  // an unrelated library: nothing exists here by name
  const unrelated = tokens({
    collections: [{ name: "Brand", key: "brand-1", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [
      { name: "Brand/Red", collection: "Brand", key: "b1", type: "COLOR", values: { "Mode 1": "#f00" } },
      { name: "Brand/Blue", collection: "Brand", key: "b2", type: "COLOR", values: { "Mode 1": "#00f" } },
    ],
  });
  const ru = crossCheck({ screens: [screen("S", [])], variables: unrelated, tokens: DS_TOKENS });
  const fu = get(ru, "foreign-token-library");
  ok("[DT07-2] an unrelated library: agree 0, absent N, and 'not the screen's library'",
    JSON.stringify(fu.nameMap) === JSON.stringify({ agree: 0, differ: 0, undecidable: 0, absent: 2 }) && /none of them exists here by name — this is not the screen's library; pull the one it uses/i.test(fu.message) && !/Mapping by NAME is safe/.test(fu.message));

  // no shared mode, overlapping values -> undecidable; a variable outside the foreign collections is not counted
  const und = tokens({
    collections: [...FOREIGN_COLL, { name: "Spacing", key: "ds-space", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [
      { name: "Text/Main", collection: "Sem", key: "screen-k1", type: "COLOR", values: { Night: "#fff", Day: "#222" } },
      { name: "Space 3", collection: "Spacing", key: "ds-k2", type: "FLOAT", values: { "Mode 1": 16 } },
    ],
  });
  const rn = crossCheck({ screens: [screen("S", [])], variables: und, tokens: DS_TOKENS });
  const fn = get(rn, "foreign-token-library");
  ok("[DT07-2] no shared mode + overlapping values is undecidable; variables in design-system collections are not counted",
    JSON.stringify(fn.nameMap) === JSON.stringify({ agree: 0, differ: 0, undecidable: 1, absent: 0 }) && /of the 1 variables in those collections/.test(fn.message));
}

// ---------------------------------------------------------------- FU-namemap: collections told apart by key
console.log("cross-check — FU-namemap: two collections of one name are told apart by their key:");
{
  // The screen binds TWO collections called "Spacing": the design system's own (ds-space) and another library's.
  // Only the second is foreign. Its rows are told apart by `collectionKey`; an export from before that field
  // can only go by the collection name.
  const COLLS = [
    { name: "Spacing", key: "ds-space", modes: ["Mode 1"], default: "Mode 1" },
    { name: "Spacing", key: "other-space", modes: ["Mode 1"], default: "Mode 1" },
  ];
  const rows = (withKeys: boolean) => tokens({
    collections: COLLS,
    variables: [
      { name: "Space 3", collection: "Spacing", ...(withKeys ? { collectionKey: "other-space" } : {}), key: "o-1", type: "FLOAT", values: { "Mode 1": 16 } },
      { name: "Space 9", collection: "Spacing", ...(withKeys ? { collectionKey: "ds-space" } : {}), key: "d-1", type: "FLOAT", values: { "Mode 1": 36 } },
    ],
  });
  const run = (withKeys: boolean) => get(crossCheck({ screens: [screen("S", [])], variables: rows(withKeys), tokens: DS_TOKENS }), "foreign-token-library");
  const keyed = run(true);
  ok("[G21-NM] with collectionKey only the foreign collection's row is counted (n=1, agrees, no ambiguity)",
    JSON.stringify(keyed.nameMap) === JSON.stringify({ agree: 1, differ: 0, undecidable: 0, absent: 0 }) && /of the 1 variables in those collections/.test(keyed.message) && !/predates collection keys/.test(keyed.message));
  const old = run(false);
  ok("[G21-NM] without collectionKey both rows go by the name: n=2, and ambiguous counts them",
    JSON.stringify(old.nameMap) === JSON.stringify({ agree: 1, differ: 0, undecidable: 0, absent: 1, ambiguous: 2 }) && /of the 2 variables in those collections/.test(old.message));
  ok("[G21-NM] the message says 2 of them come from a collection whose name a design-system collection also has, and to re-pull",
    /\(2 of them come from a collection whose name a design-system collection also has — this export predates collection keys on variables; re-pull to tell them apart\.\)/.test(old.message));
  // A key the screen's collection list does not know selects nothing: the row falls back to its name (and is ambiguous).
  const stray = get(crossCheck({ screens: [screen("S", [])], variables: tokens({ collections: COLLS, variables: [{ name: "Space 3", collection: "Spacing", collectionKey: "nobody", key: "o-1", type: "FLOAT", values: { "Mode 1": 16 } }] }), tokens: DS_TOKENS }), "foreign-token-library");
  ok("[G21-NM] a collectionKey no screen collection carries falls back to the name", JSON.stringify(stray.nameMap) === JSON.stringify({ agree: 1, differ: 0, undecidable: 0, absent: 0, ambiguous: 1 }));
  // Both twins foreign (the real-data shape): every row is counted by key or by name alike, nothing ambiguous.
  const bothForeign = get(crossCheck({ screens: [screen("S", [])], variables: tokens({
    collections: [{ name: "Spacing", key: "x-1", modes: ["Mode 1"], default: "Mode 1" }, { name: "Spacing", key: "x-2", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [
      { name: "Space 3", collection: "Spacing", collectionKey: "x-1", key: "a", type: "FLOAT", values: { "Mode 1": 16 } },
      { name: "Space 9", collection: "Spacing", collectionKey: "x-2", key: "b", type: "FLOAT", values: { "Mode 1": 36 } },
    ] }), tokens: DS_TOKENS }), "foreign-token-library");
  ok("[G21-NM] two foreign twins: both rows counted, no ambiguity",
    JSON.stringify(bothForeign.nameMap) === JSON.stringify({ agree: 1, differ: 0, undecidable: 0, absent: 1 }));
}

// ---------------------------------------------------------------- name collides, value differs
console.log("cross-check — two libraries, one name, two values:");
{
  // The live case exactly: `(Space 3)`=12 on Desktop vs `Space 3`=16 on "Mode 1". No mode name is
  // shared, so any comparison that needs aligned modes reports nothing — and this is the single most
  // dangerous collision there is, because a slugger maps both onto one custom property.
  const vars = tokens({
    collections: [{ name: "Spacing", key: "screen-space", modes: ["Desktop", "Tablet"], default: "Desktop" }],
    variables: [{ name: "(Space 3)", collection: "Spacing", key: "screen-k2", type: "FLOAT", values: { Desktop: 12, Tablet: 8 } }],
  });
  const res = crossCheck({ screens: [screen("S", [])], variables: vars, tokens: DS_TOKENS });
  // D1: a clash blocks only when a visible layer on the screen binds the token.
  ok("[collision/D1] a punctuation-only name twin nobody on the screen binds is a warning to confirm (was: a blocker)",
    sev(res, "token-name-collision") === "warning" && /no visible layer on this screen binds it/.test(get(res, "token-name-collision").confirm ?? ""));
  const bound = crossCheck({ screens: [screen("S", [{ id: "3:1", type: "FRAME", name: "Row", tokens: { itemSpacing: "(Space 3)" } }])], variables: vars, tokens: DS_TOKENS });
  ok("[collision/D1] …and a blocker once a visible layer binds it", sev(bound, "token-name-collision") === "blocker" && get(bound, "token-name-collision").confirm === undefined);
  const hiddenBound = crossCheck({ screens: [screen("S", [{ id: "3:2", type: "FRAME", name: "Row", hidden: true, tokens: { itemSpacing: "(Space 3)" } }])], variables: vars, tokens: DS_TOKENS });
  ok("[collision/D1] a HIDDEN layer binding it does not make it a blocker", sev(hiddenBound, "token-name-collision") === "warning");
  ok("[collision] the message carries BOTH values so the reader can pick", /12/.test(get(res, "token-name-collision").message) && /16/.test(get(res, "token-name-collision").message));
  ok("[collision] and says why no per-mode comparison was possible",
    /no mode name is shared/.test(get(res, "token-name-collision").message));
}
{
  // Aliases that point at the same target agree, even across libraries — the common, safe case. An
  // early version called every re-keyed variable a conflict, which would have cried wolf on the whole file.
  const vars = tokens({
    collections: [{ name: "Sem", key: "screen-sem", modes: ["Dark"], default: "Dark" }],
    variables: [{ name: "Text/Main", collection: "Sem", key: "s1", type: "COLOR", values: { Dark: { aliasOf: "Gray/900" } } }],
  });
  const ds = tokens({ ...ifDefined("collections", DS_TOKENS.collections), variables: [{ name: "Text/Main", collection: "Sem", key: "d1", type: "COLOR", values: { Dark: { aliasOf: "Gray/900" }, Light: { aliasOf: "Gray/0" } } }] });
  const res = crossCheck({ screens: [screen("S", [])], variables: vars, tokens: ds });
  ok("[collision] two libraries that alias the same target are NOT a conflict", !has(res, "token-name-collision"));
}

// ---------------------------------------------------------------- catalog coverage of THIS screen
console.log("cross-check — does the catalog cover the screen:");
{
  const res = crossCheck({
    screens: [screen("S", [instance("2:1", "other-a", "Widget"), instance("2:2", "other-b", "Gadget"), instance("2:3", "other-b", "Gadget")])],
    components: DS_COMPONENTS,
  });
  ok("[coverage/D11] 0% by key is a warning with a confirm question, not an empty success (was: a blocker)",
    sev(res, "catalog-covers-nothing") === "warning" && /components.local.json by key — is that the component library/.test(get(res, "catalog-covers-nothing").confirm ?? ""));
  ok("[coverage] it counts distinct components, not instances", res.coverage?.distinct === 2 && res.coverage?.instances === 3);
  ok("[coverage] and says outright that a catalog-vs-map count means nothing here",
    /measures the catalog against itself/.test(get(res, "catalog-covers-nothing").message));
  ok("[coverage] it names the one Figma action that finds the owning library",
    /Go to main component/.test(get(res, "catalog-covers-nothing").message));
}
{
  const res = crossCheck({
    screens: [screen("S", [instance("2:1", "ds-btn", "Button"), instance("2:2", "other", "Widget")])],
    components: DS_COMPONENTS,
  });
  ok("[coverage] a real partial match is a warning with the real percentage",
    sev(res, "partial-catalog-coverage") === "warning" && res.coverage?.localPct === 50);
}
{
  // A hit in components.library.json means both FILES consume the same third-party set — it must not
  // be folded into the local number, which is the one build-screen actually maps against.
  const res = crossCheck({
    screens: [screen("S", [instance("2:1", "lib-icon", "icons/linear/book")])],
    components: DS_COMPONENTS,
    componentsLibrary: { components: [{ name: "icons/linear/book", key: "lib-icon", type: "COMPONENT" }] },
  });
  ok("[coverage] a library-catalog hit does NOT count towards local coverage",
    res.coverage?.matchedByKey === 1 && res.coverage?.matchedByLocalKey === 0 && res.coverage?.localPct === 0);
  ok("[coverage] and the finding still fires, saying what the library hit actually means",
    sev(res, "catalog-covers-nothing") === "warning" && /same third-party set/.test(get(res, "catalog-covers-nothing").message));
}
{
  // Name fallback: a unique name with overlapping props is a LEAD. An ambiguous one is a coin flip
  // and is deliberately left unmatched — `Header` exists twice in the catalog.
  const res = crossCheck({
    screens: [screen("S", [instance("2:1", "x", "Button", { "Btn Text": "Go" }), instance("2:2", "y", "Header")])],
    components: DS_COMPONENTS,
  });
  ok("[coverage] a unique name + prop overlap is offered as an unverified lead", res.coverage?.matchedByName === 1);
  ok("[coverage] the lead is reported ONCE for the whole set, not once per component",
    res.findings.filter((f) => f.code === "name-matched-components").length === 1);
  ok("[coverage] and every lead carries verified:false", (get(res, "name-matched-components").components || []).every((c) => c.verified === false));
  ok("[coverage] an AMBIGUOUS name is left unmatched, not guessed",
    res.coverage?.ambiguousName === 1 && has(res, "ambiguous-component-name"));
  ok("[coverage] the ambiguous warning says how many candidates there were",
    /2 candidates/.test(get(res, "ambiguous-component-name").message));
}

// ---------------------------------------------------------------- fonts and text styles
console.log("cross-check — fonts and text styles:");
{
  const res = crossCheck({
    screens: [screen("S", [text("2:1", "Poppins"), text("2:2", "Poppins"), text("2:3", "Roboto", "material-theme/label/large")])],
    stylesText: DS_TEXT_STYLES,
  });
  ok("[fonts] a minority family is reported as a stray with its count",
    has(res, "font-family-stray") && /Roboto \(1\)/.test(get(res, "font-family-stray").message));
  ok("[fonts] a font no design-system text style uses is called out separately",
    has(res, "font-not-in-design-system"));
  ok("[fonts] and the licensing question the export cannot answer is raised, not assumed",
    /licensed/.test(get(res, "font-not-in-design-system").message));
  ok("[styles] a text style absent from the design system is listed", has(res, "text-style-absent"));
}
{
  // One capital letter apart. This is a blocker because a name-based mapping binds it silently.
  const res = crossCheck({ screens: [screen("S", [text("2:1", "Poppins", "Medium/14 Medium")])], stylesText: DS_TEXT_STYLES });
  ok("[styles/D1] a case-only near-miss is a warning to confirm, not a missing style (was: a blocker)",
    sev(res, "text-style-near-miss") === "warning" && /the same style\?/.test(get(res, "text-style-near-miss").confirm ?? ""));
  ok("[styles] and it prints both spellings side by side",
    /'Medium\/14 Medium' vs 'Medium\/14 medium'/.test(get(res, "text-style-near-miss").message));
}

// ---------------------------------------------------------------- sentinels and single-mode exports
console.log("cross-check — sentinel values and missing modes:");
{
  const res = crossCheck({ screens: [screen("S", [])], tokens: DS_TOKENS, variables: DS_TOKENS });
  ok("[sentinel] a radius of 1e9 is reported as a sentinel, not a measurement", has(res, "sentinel-token-value"));
  ok("[sentinel] it is reported ONCE even though both inputs carry the same variable",
    (get(res, "sentinel-token-value").tokens || []).length === 1);
  ok("[sentinel] and it names each platform's real idiom instead of a number",
    /9999px or 50%/.test(get(res, "sentinel-token-value").message) && /infinity/.test(get(res, "sentinel-token-value").message));
}
{
  const res = crossCheck({ screens: [screen("S", [])], tokens: DS_TOKENS });
  ok("[modes] a two-mode collection exported only in Dark is flagged", has(res, "single-mode-export"));
  ok("[modes] the message names the modes that were never rendered",
    /'Light'/.test(get(res, "single-mode-export").message));
  ok("[modes] and warns that a derived mode can be mechanically right and visually broken",
    /visually broken/.test(get(res, "single-mode-export").message));
}

// F-20: the "dark surface" example belongs to colour collections; a number collection gets its own.
{
  const sizes = tokens({
    collections: [{ name: "Font Sizes", key: "c-fs", modes: ["Desktop", "Mobile"], default: "Desktop" }],
    variables: [{ name: "Body", collection: "Font Sizes", key: "fs-1", type: "FLOAT", values: { Desktop: 16, Mobile: 14 } }],
  });
  const doc = screenExport([{ type: "FRAME", id: "1:1", resolvedModes: { "Font Sizes": "Desktop" } }], { screen: "S" });
  const res = crossCheck({ screens: [{ doc, label: "S" }], variables: sizes });
  const m = get(res, "single-mode-export").message;
  ok("[F-20] a single-mode FLOAT collection's message has no 'dark surface' example", !/dark surface/.test(m) && /size or spacing value that should differ in 'Mobile'/.test(m));
  const colour = crossCheck({ screens: [screen("S", [])], tokens: DS_TOKENS });
  ok("[F-20] …while a colour collection keeps it", /dark surface/.test(get(colour, "single-mode-export").message));
}
// Group 4 owed: a library dir's catalog is components.json, and the advice is not "export the library you just exported".
{
  const res = crossCheck({ screens: [screen("S", [instance("2:1", "other-a", "Widget")])], components: DS_COMPONENTS, componentsFile: "components.json", designSystemIsLibrary: true });
  const m = get(res, "catalog-covers-nothing").message;
  ok("[library-dir] findings name the catalog actually read (components.json), not components.local.json", /in components\.json by key/.test(m) && !/components\.local\.json/.test(m));
  ok("[library-dir] and the advice checks the passed library instead of saying to export one", /check that the library export you passed is the one the screen consumes/.test(m));
}

// ---------------------------------------------------------------- the mode nobody ever saw
console.log("cross-check — contrast in a mode that was derived, not drawn:");
{
  // The live case: `Backgrounds/Side menu` stays a DARK surface in Light while the sidebar's own
  // label token flips to a dark gray, so the derived Light sidebar's nav labels are near-invisible.
  // Mechanically correct, visually broken, and nothing in the toolchain looked.
  const vars = tokens({
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Backgrounds/Side menu", collection: "Sem", key: "b1", type: "COLOR", values: { Dark: "#121319", Light: "#2b2b4f" } },
      { name: "Neutrals/Neutral 500", collection: "Sem", key: "t1", type: "COLOR", values: { Dark: "#d4d4d4", Light: "#46464f" } },
    ],
  });
  const sidebar = node({
    type: "FRAME", id: "1:1", name: "Side menu", resolvedModes: { Sem: "Dark" }, tokens: { fills: "Backgrounds/Side menu" },
    children: [text("2:1", "Poppins", null, "Neutrals/Neutral 500")],
  });
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [sidebar] }, label: "S" }], variables: vars });
  ok("[contrast/D11] a derived mode's unreadable pair is a warning to confirm (was: a blocker)",
    sev(res, "derived-mode-contrast") === "warning" && /was never drawn/.test(get(res, "derived-mode-contrast").confirm ?? ""));
  ok("[contrast] it names the mode that was never drawn, not the one that was",
    get(res, "derived-mode-contrast").mode === "Light");
  ok("[contrast] and reports the actual ratio, not a verdict",
    (get(res, "derived-mode-contrast").pairs?.[0]?.ratio ?? 0) < 4.5 && (get(res, "derived-mode-contrast").pairs?.[0]?.ratio ?? 0) > 1);
  // An OPAQUE pair is not composited: #46464f on #2b2b4f is the plain WCAG ratio, 1.44 (unchanged).
  ok("[contrast] an opaque pair's ratio is the plain WCAG one: #46464f on #2b2b4f = 1.44",
    get(res, "derived-mode-contrast").pairs?.[0]?.ratio === 1.44);
  ok("[contrast] the fix it asks for is a designer answer or a real frame, never an invented override",
    /Do not invent an override/.test(get(res, "derived-mode-contrast").message));
}
{
  // The mode that WAS exported already has a strictly better check in audit.js, which walks the real
  // composited backgrounds. Reporting it here just re-raises that check's known false positives.
  const vars = tokens({
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Bg", collection: "Sem", key: "b1", type: "COLOR", values: { Dark: "#121319", Light: "#ffffff" } },
      { name: "Fg", collection: "Sem", key: "t1", type: "COLOR", values: { Dark: "#131320", Light: "#000000" } },
    ],
  });
  const frame = node({ type: "FRAME", id: "1:1", name: "F", resolvedModes: { Sem: "Dark" }, tokens: { fills: "Bg" }, children: [text("2:1", "Poppins", null, "Fg")] });
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [frame] }, label: "S" }], variables: vars });
  ok("[contrast] the mode that WAS rendered is left to the audit's composited check", !has(res, "derived-mode-contrast"));
}
{
  const vars = tokens({
    collections: [{ name: "Sem", key: "c1", modes: ["Only"], default: "Only" }],
    variables: [{ name: "Bg", collection: "Sem", key: "b1", type: "COLOR", values: { Only: "#000000" } }],
  });
  const frame = node({ type: "FRAME", id: "1:1", name: "F", resolvedModes: { Sem: "Only" }, tokens: { fills: "Bg" }, children: [] });
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [frame] }, label: "S" }], variables: vars });
  ok("[contrast] a single-mode system derives nothing, so it is never warned about", !has(res, "derived-mode-contrast"));
}

{
  // A composed colour (colour + separate 0–100 opacity, Figma Update 139) resolves to ONE RGBA:
  // alpha = colour alpha × opacity/100, the opacity clamped to 0–100 as Figma clamps it.
  const red = must(parseHex("#ff0000"), "#ff0000 parses");
  const half = must(parseHex("#ff000080"), "#ff000080 parses");
  const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 0.005;
  ok("[composed] #ff0000 at opacity 60 -> alpha 0.6, channels kept", (() => { const c = composedRgba(red, 60); return !!c && c.r === 255 && c.g === 0 && c.b === 0 && near(c.a, 0.6); })());
  ok("[composed] a colour with alpha 0.5 at opacity 60 -> alpha 0.3 (multiplied)", near(composedRgba(half, 60)?.a, 0.3));
  ok("[composed] opacity 120 clamps to 100 (alpha 1), -5 clamps to 0", near(composedRgba(red, 120)?.a, 1) && near(composedRgba(red, -5)?.a, 0));
  ok("[composed] an unresolved half stays null", composedRgba(null, 60) === null && composedRgba(red, null) === null);
  // End to end: the derived mode's contrast now sees a composed text colour (it was skipped as null),
  // through both an aliased colour half and an aliased opacity half.
  const vars = tokens({
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Bg", collection: "Sem", key: "b1", type: "COLOR", values: { Dark: "#121319", Light: "#2b2b4f" } },
      { name: "Ink", collection: "Sem", key: "i1", type: "COLOR", values: { Dark: "#d4d4d4", Light: "#46464f" } },
      { name: "Op", collection: "Sem", key: "o1", type: "FLOAT", scopes: ["COLOR_OPACITY"], values: { Dark: 60, Light: 60 } },
      { name: "Fg", collection: "Sem", key: "t1", type: "COLOR", values: {
        Dark: { composed: { color: { aliasOf: "Ink" }, opacity: { aliasOf: "Op" } } },
        Light: { composed: { color: { aliasOf: "Ink" }, opacity: { aliasOf: "Op" } } } } },
    ],
  });
  const frame = node({ type: "FRAME", id: "1:1", name: "F", resolvedModes: { Sem: "Dark" }, tokens: { fills: "Bg" }, children: [text("2:1", "Poppins", null, "Fg")] });
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [frame] }, label: "S" }], variables: vars });
  ok("[composed] a composed text colour resolves in the derived mode, so its contrast is checked",
    has(res, "derived-mode-contrast") && get(res, "derived-mode-contrast").pairs?.[0]?.fg === "Fg");
  const gone = tokens({
    ...ifDefined("collections", vars.collections),
    variables: (vars.variables || []).filter((v) => v.name !== "Op"),
  });
  ok("[composed] an opacity alias that does not resolve leaves the pair unchecked (null, not a guess)",
    !has(crossCheck({ screens: [{ doc: { screen: "S", nodes: [frame] }, label: "S" }], variables: gone }), "derived-mode-contrast"));
}

// ---------------------------------------------------------------- color.ts: the one opacity rule + compositing
{
  // clampOpacityPct: Figma's clamp (Help Center 14506821864087): negative -> 0, > 100 -> 100, in range verbatim.
  ok("[color] clampOpacityPct: -5 -> 0, 120 -> 100, 40 -> 40, 12.5 -> 12.5",
    clampOpacityPct(-5) === 0 && clampOpacityPct(120) === 100 && clampOpacityPct(40) === 40 && clampOpacityPct(12.5) === 12.5);
  // composeAlpha: alpha × clamp(pct)/100 — 0.5 × 60/100 = 0.3; 1 × 150 -> 1 × 100/100 = 1; 1 × -5 -> 0.
  ok("[color] composeAlpha: (0.5, 60) = 0.3, (1, 150) = 1, (1, -5) = 0, (1, 40) = 0.4",
    composeAlpha(0.5, 60) === 0.3 && composeAlpha(1, 150) === 1 && composeAlpha(1, -5) === 0 && composeAlpha(1, 40) === 0.4);
  // formatHex: alpha 0.5 -> round(127.5) = 128 = 0x80; alpha 1 -> 255 -> 6 digits.
  ok("[color] formatHex: #111111 at alpha 0.5 -> \"#11111180\", opaque -> \"#111111\"",
    formatHex({ r: 17, g: 17, b: 17, a: 0.5 }) === "#11111180" && formatHex({ r: 17, g: 17, b: 17, a: 1 }) === "#111111");
  // compositeOver: black at alpha 0.5 over white -> 0 × 0.5 + 255 × 0.5 = 127.5 per channel, opaque.
  const c = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  ok("[color] compositeOver: #000000 at alpha 0.5 over #ffffff = (127.5, 127.5, 127.5, 1)", c.r === 127.5 && c.g === 127.5 && c.b === 127.5 && c.a === 1);
}

console.log("cross-check — contrast of a TRANSLUCENT text colour (WCAG 2.2 on the rendered colour):");
{
  // Fg = #000000 composed at opacity 50 over Bg = #ffffff, in the derived mode (Light).
  // Rendered fg (color.ts compositeOver): 0 × 0.5 + 255 × 0.5 = 127.5 per channel.
  // Relative luminance (WCAG 2.2 #dfn-relative-luminance): 127.5/255 = 0.5 > 0.04045, so
  //   ((0.5 + 0.055) / 1.055)^2.4 = 0.526066^2.4 = 0.214041; equal channels -> L = 0.214041.
  // Contrast (#dfn-contrast-ratio): (1 + 0.05) / (0.214041 + 0.05) = 1.05 / 0.264041 = 3.9767 -> 3.98.
  // Without compositing it would be black on white, 21:1, and no finding at all.
  const vars = tokens({
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Surface", collection: "Sem", key: "b1", type: "COLOR", values: { Dark: "#000000", Light: "#ffffff" } },
      { name: "Ink", collection: "Sem", key: "i1", type: "COLOR", values: { Dark: "#000000", Light: "#000000" } },
      { name: "Label", collection: "Sem", key: "t1", type: "COLOR", values: {
        Dark: "#ffffff",
        Light: { composed: { color: { aliasOf: "Ink" }, opacity: 50 } } } },
    ],
  });
  const frame = node({ type: "FRAME", id: "1:1", name: "Card", resolvedModes: { Sem: "Dark" }, tokens: { fills: "Surface" }, children: [text("2:1", "Inter", null, "Label")] });
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [frame] }, label: "S" }], variables: vars });
  const f = res.findings.find((x) => x.code === "derived-mode-contrast");
  const pair0 = f?.pairs?.[0];
  ok("[contrast-alpha] black at 50% on white, composited: ratio 3.98 in mode 'Light' (21 if alpha were ignored)",
    !!f && f.mode === "Light" && f.pairs?.length === 1 && pair0?.ratio === 3.98 && pair0?.fg === "Label" && pair0?.bg === "Surface");
  ok("[contrast-alpha] the message carries the composited ratio", !!f && f.message.includes("'Label' on 'Surface' = 3.98:1"));
}

// ---------------------------------------------------------------- honesty about what it could not do
console.log("cross-check — what it could NOT check:");
{
  const res = crossCheck({ screens: [screen("S", [instance("2:1", "a", "Widget")])] });
  ok("[gaps] with no design system, the gap is REPORTED rather than passing quietly", res.notChecked.length >= 2);
  ok("[gaps] and no false clean verdict is emitted", !has(res, "token-library-matches") && !has(res, "catalog-covers-screen"));
  ok("[gaps] the markdown renders the gaps under their own heading", /## Not checked/.test(toMarkdown(res)));
  ok("[gaps] markdown says these are input gaps, not clean results", /gaps in the INPUT/.test(toMarkdown(res)));
}

// ---------------------------------------------------------------- drift-lint's screen coverage
console.log("drift-lint — coverage of the screen, not of the catalog:");
{
  const map = codeMap({ Button: { figma: { key: "ds-btn", name: "Button" } } });
  const doc = screenExport([{ type: "FRAME", id: "1:1", children: [instance("2:1", "other-a", "Widget"), instance("2:2", "other-a", "Widget")] }]);
  const cov = screenCoverage(map, DS_COMPONENTS, [doc]);
  ok("[screen-cov] a map covering the whole catalog can still cover 0% of the screen",
    cov.distinct === 1 && cov.inMap === 0 && cov.mapPct === 0);
  ok("[screen-cov] instances are counted separately from distinct components", cov.instances === 2);
  const unmapped0 = cov.unmapped[0];
  ok("[screen-cov] the unmapped list names the component and how often it appears",
    cov.unmapped.length === 1 && unmapped0?.setName === "Widget" && unmapped0?.instances === 2);
}
{
  const map = codeMap({ Button: { figma: { key: "ds-btn", name: "Button" } } });
  const doc = screenExport([{ type: "FRAME", id: "1:1", children: [instance("2:1", "ds-btn", "Button"), instance("2:2", "other", "Widget")] }]);
  const cov = screenCoverage(map, DS_COMPONENTS, [doc]);
  ok("[screen-cov] a real half-match reports 50%, in the map and in the catalog", cov.mapPct === 50 && cov.catalogPct === 50);
}

// ---------- drift-lint SCREEN COVERAGE says how much of "the screen" is hidden (P2a, 107/139/185) ----------
// The real Guided Policies export: 87 instances, 45 of them on layers the designer switched off. The
// coverage line keeps its numbers (it is map/catalog coverage by key) but must say how many of those
// instances — and which whole sets — will never be built, and that it is NOT a build-coverage number.
{
  const gp = readFixture(path.join(import.meta.dirname, "fixtures", "livetest3", "verify", "Studio_Configurations__1359_21337.json"), isScreenExport);
  const cov = screenCoverage(codeMap({}), { components: [] }, [gp]);
  ok("[drift-lint wording] instances are still counted in full (87), with the 45 on hidden layers named", cov.instances === 87 && cov.hiddenInstances === 45);
  ok("[drift-lint wording] sets that appear ONLY on hidden layers are counted (never built)", cov.hiddenOnly > 0 && cov.hiddenOnly < cov.distinct);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p2a-drift-"));
  fs.writeFileSync(path.join(tmp, "map.json"), JSON.stringify({ version: 1, components: {} })); // a VALID empty map (drift-lint validates it)
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", "drift-lint.ts"), path.join(tmp, "map.json"),
    path.join(import.meta.dirname, "fixtures", "livetest3", "design-system", "components.local.json"),
    "--screen", path.join(import.meta.dirname, "fixtures", "livetest3", "verify", "Studio_Configurations__1359_21337.json")], { encoding: "utf8" });
  ok("[drift-lint wording] the printed line names the hidden instances and says it measures reuse by key, not what the build contains",
    /SCREEN COVERAGE: \d+\/\d+ .* 87 instance\(s\) total, 45 of them on hidden layers/.test(r.stderr) && /not which ones the build contains/.test(r.stderr));
}

// ---------- cross-check never cites a hidden layer (P2a; hidden.js predicate in both walks) ----------
// Real Jet Roles export (test/fixtures/livetest3/verify/). Before: `walkWithBg` skipped
// `visible === false` (a flag the export never sets) and the token-usage walk skipped nothing, so
// `token-name-collision` cited the hidden `I20173:137670;1929:15178` / `;1929:15308` buttons and the
// derived-mode contrast check graded hidden text.
{
  const FXL = path.join(import.meta.dirname, "fixtures", "livetest3");
  const jr = readFixture(path.join(FXL, "verify", "positions___7314_87192.json"), isScreenExport);
  const hidden = new Set<string | undefined>();
  (function w(n: { id?: string; hidden?: boolean; children?: IrNode[] }, h: boolean) { h = h || !!n.hidden; if (h && n.id) hidden.add(n.id); for (const c of n.children || []) w(c, h); })({ children: jr.nodes }, false);
  const citesHidden = (f: unknown) => { let hit = false; JSON.stringify(f, (_k: string, v: unknown) => { if (typeof v === "string" && hidden.has(v)) hit = true; return v; }); return hit; };
  const rd = <T,>(p: string, guard: DocGuard<T>): T => readFixture(path.join(FXL, p), guard);
  const tokRes = crossCheck({ screens: [{ doc: jr, label: "positions___7314_87192" }],
    variables: rd("pages/__Optimization_management_/positions___7314_87192.vars.json", isTokensDoc), tokens: rd("design-system/tokens.json", isTokensDoc),
    components: rd("design-system/components.local.json", isComponentsCatalog), componentsLibrary: rd("design-system/components.library.json", isComponentsCatalog) });
  ok("[hidden] token findings on the real Jet Roles export cite no hidden node", tokRes.findings.length > 0 && !tokRes.findings.some(citesHidden));
  // Derived-mode contrast. The export was rendered in 'Semantic Vectors 01' = Dark (root.resolvedModes);
  // a 'Dim' mode (rendered nowhere — note 'Light' IS rendered, by the 'Default' collection) is declared
  // and both pairs are given a 1:1 contrast there. Pair A
  // ('Text/Description' on 'Backgrounds/Page Color') is used ONLY by hidden text (7 nodes); pair B
  // ('Text/Main Titles' on 'Backgrounds/Table header') only by visible text (5 nodes) — the control.
  const vars = tokens({
    collections: [{ name: "Semantic Vectors 01", modes: ["Dark", "Dim"] }],
    variables: [
      { name: "Text/Description", type: "COLOR", collection: "Semantic Vectors 01", values: { Dim: "#1d1d1f" } }, { name: "Backgrounds/Page Color", type: "COLOR", collection: "Semantic Vectors 01", values: { Dim: "#1d1d1f" } },
      { name: "Text/Main Titles", type: "COLOR", collection: "Semantic Vectors 01", values: { Dim: "#46464f" } }, { name: "Backgrounds/Table header", type: "COLOR", collection: "Semantic Vectors 01", values: { Dim: "#46464f" } },
    ],
  });
  const c = crossCheck({ screens: [{ doc: jr, label: "positions___7314_87192" }], variables: vars });
  const dm = c.findings.find((f) => f.code === "derived-mode-contrast");
  ok("[hidden] derived-mode contrast still fires on VISIBLE text (the check is not dead)", dm !== undefined && (dm.pairs || []).some((p) => p.fg === "Text/Main Titles"));
  ok("[hidden] …and never grades a pair used only by hidden text, nor cites a hidden node", dm !== undefined && !(dm.pairs || []).some((p) => p.fg === "Text/Description") && !citesHidden(dm));
}

// ---------------------------------------------------------------- CLI: auto-discovery of variables.json (P4 #38/#39/#138) ----------
// Real layout: test/fixtures/livetest3/pages/<Page>/<Screen>.json + test/fixtures/livetest3/variables.json
// (the export root, two levels up from the screen file) — the same shape design/export/ has in a real
// project. Before the fix, the CLI looked in path.dirname(argv[0]) (the <Page> directory) and never
// found the export-root file, so every invocation without an explicit --variables reported "not
// checked". After the fix it is found automatically and the path used is printed on stderr.
{
  const FXL = path.join(import.meta.dirname, "fixtures", "livetest3");
  const screen = path.join(FXL, "pages", "__Optimization_management_", "positions___7314_87192.json");
  const dsDir = path.join(FXL, "design-system");
  const withoutFlag = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", "cross-check.ts"),
    screen, "--design-system", dsDir, "--json"], { encoding: "utf8" });
  const withFlag = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", "cross-check.ts"),
    screen, "--design-system", dsDir, "--variables", path.join(FXL, "variables.json"), "--json"], { encoding: "utf8" });
  ok("[cli-autodiscover] no --variables prints which path it auto-discovered", withoutFlag.stderr.includes(path.join(FXL, "variables.json")));
  const resNoFlag = parseAs(withoutFlag.stdout, isCrossCheckReport, "cross-check --json");
  const resFlag = parseAs(withFlag.stdout, isCrossCheckReport, "cross-check --json (--variables)");
  ok("[cli-autodiscover] auto-discovery reports the SAME blocker count as passing --variables explicitly",
    resNoFlag.summary.blockers === resFlag.summary.blockers && resNoFlag.summary.warnings === resFlag.summary.warnings);
  ok("[cli-autodiscover] the stale-wording bug is gone: never says 'no design/variables.json was given' while one exists",
    !withoutFlag.stdout.includes("no design/variables.json was given"));
}


// ---------- livetest-3 #318 / #326 on the REAL export (test/fixtures/livetest3/) ----------
{
  const FX = path.join(import.meta.dirname, "fixtures", "livetest3");
  // What the CLI's --json prints (a CrossCheckReport), or the empty stand-in when it printed nothing parseable.
  type CliReport = Pick<CrossCheckReport, "findings" | "componentProposals"> & { coverage: Partial<CrossCheckCoverage> | null };
  const run = (rel: string): CliReport => {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", "cross-check.ts"), path.join(FX, rel), "--design-system", path.join(FX, "design-system"), "--json"], { encoding: "utf8" });
    return r.stdout ? parseAs(r.stdout, isCrossCheckReport, "cross-check --json") : { coverage: {}, findings: [] };
  };
  // What the build sees: the distinct component sets of VISIBLE instances, and the sets used only on
  // hidden layers — computed here from the fixture itself, not from the tool's own counters.
  const sets = (rel: string) => {
    const doc = readFixture(path.join(FX, rel), isScreenExport);
    const vis = new Set<string | undefined>(), all = new Set<string | undefined>();
    const w = (n: IrNode, hid: boolean) => {
      const h = hid || n.hidden === true;
      if (n.type === "INSTANCE" && n.mainComponent) { const k = n.mainComponent.setKey || n.mainComponent.key; all.add(k); if (!h) vis.add(k); }
      for (const c of n.children || []) w(c, h);
    };
    for (const r of doc.nodes) w(r, false);
    return { visible: vis.size, hiddenOnly: [...all].filter((k) => !vis.has(k)).length };
  };
  const labeledFixtures: [string, string][] = [["Jet Roles", "pages/__Optimization_management_/positions___7314_87192.json"], ["Guided Policies", "pages/__Optimization_management_/Studio_Configurations__1359_21337.json"]];
  for (const [label, rel] of labeledFixtures) {
    const res = run(rel), truth = sets(rel);
    const b: Partial<Record<CoverageBucket, number>> = res.coverage?.buckets || {};
    const sum = Object.values(b).reduce((n: number, x: number) => n + x, 0);
    ok(`[318] ${label}: every visible component set lands in exactly ONE bucket — the rows sum to the ${truth.visible} sets the screen really has`,
      truth.visible > 0 && res.coverage?.distinct === truth.visible && sum === truth.visible
        && (res.coverage?.entries || []).every((e) => typeof e.bucket === "string") && (res.coverage?.entries || []).length === truth.visible);
    ok(`[318] ${label}: sets used only on hidden layers are reported apart (${truth.hiddenOnly}), not mixed into the buckets`,
      res.coverage?.hiddenOnly === truth.hiddenOnly);
    ok(`[318] ${label}: no name is both a proposal and "new work" or an ambiguous leftover`,
      (res.componentProposals || []).every((p) => !(res.coverage?.entries || []).some((e) => e.setName === p.name && e.bucket !== "proposed")));
  }
  const cat = run("pages/In_progress/Create_Assembly_Type__18411_84111.json");
  const s4 = cat.findings.find((f) => f.code === "token-name-collision" && f.token === "Space 4");
  ok("[326] an identical-name collision names BOTH subjects: \"The screen's 'Space 4' (key …) and the design system's 'Space 4' share a name\"",
    !!s4 && /^The screen's 'Space 4' \(key 64928e3a…\) and the design system's 'Space 4' share a name but resolve DIFFERENTLY/.test(s4.message));
}


// ---------- wrong-kind inputs are one line + exit 2 (doc-guards.ts), never a TypeError or a quiet "not checked" ----------
{
  const CLI = path.join(import.meta.dirname, "..", "design-to-code", "cross-check.ts");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cross-shape-"));
  const put = (name: string, doc: unknown): string => { const f = path.join(tmp, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
  const good = put("screen.json", { screen: "S", nodes: [{ type: "FRAME", id: "1:1", name: "S" }] });
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", cwd: tmp });
  const oneLine = (r: { status: number | null; stderr: string }, re: RegExp): boolean => r.status === 2 && re.test(r.stderr) && !/\n {4}at /.test(r.stderr);
  ok("[shape] a screen argument that is an array of nodes (not an export) -> exit 2, one line", oneLine(run([put("arr.json", [{ id: "1:1", type: "FRAME" }])]), /screen export: '.*arr\.json' is not a screen export/));
  put("ds/components.local.json", { components: [{ key: "k" }] });
  ok("[shape] a --design-system components.local.json with a nameless component -> exit 2 (was: read blindly)", oneLine(run([good, "--design-system", path.join(tmp, "ds")]), /component catalog: '.*components\.local\.json' is not a component catalog/));
  put("ds2/styles.text.json", { styles: {} });
  ok("[shape] a --design-system styles.text.json whose styles is not an array -> exit 2", oneLine(run([good, "--design-system", path.join(tmp, "ds2")]), /text styles: '.*styles\.text\.json' is not a text-style sheet/));
  ok("[shape] a --variables file that is not JSON -> exit 2 with the parser's reason", (() => { fs.writeFileSync(path.join(tmp, "v.json"), "{"); return oneLine(run([good, "--variables", path.join(tmp, "v.json")]), /variables: '.*v\.json' is not valid JSON/); })());
  ok("[args] `--out --json` is '--out needs a value' (was: wrote <cwd>/--json.json)", (() => { const r = spawnSync(process.execPath, [CLI, good, "--out", "--json"], { encoding: "utf8", cwd: tmp }); return r.status === 2 && /cross-check: --out needs a value/.test(r.stderr) && !fs.existsSync(path.join(tmp, "--json.json")); })());
}

// ---------- group 14: one name rule (DT-27), finding ids (F-44), labelled proposals (F-47) ----------
// A fixture read that fails is a ✗ on the check that needed it, never a crash of the whole file.
const tryRead = <T,>(file: string, guard: DocGuard<T>): T | null => { try { return readFixture(file, guard); } catch { return null; } };
const tryParse = <T,>(text: string, guard: DocGuard<T>): T | null => { try { return parseAs(text, guard, "cross-check --json"); } catch { return null; } };
console.log("cross-check — group 14 (DT-27 name rule, F-44 ids, F-47 proposal labels):");
{
  // [DT27-1] The fixture plan-skeleton.test.ts reads too (test/fixtures/g14/dt27/, expected.json): no
  // instance key is in the catalog, so every component is decided by NAME, and cross-check's coverage
  // must say what component-match's nameVerdict says — the rule plan-skeleton's catalog column uses.
  const FX = path.join(import.meta.dirname, "fixtures", "g14", "dt27");
  const isExpected = (x: unknown): x is { verdicts: Record<string, string> } => isJsonObject(x) && isJsonObject(x.verdicts) && Object.values(x.verdicts).every((v) => typeof v === "string");
  const doc = tryRead(path.join(FX, "Screen__5_6.json"), isScreenExport);
  const cat = tryRead(path.join(FX, "design-system", "components.local.json"), isComponentsCatalog);
  const want = tryRead(path.join(FX, "expected.json"), isExpected);
  ok("[DT27-1] the shared fixture reads (screen, catalog, expected verdicts)", !!doc && !!cat && !!want && Object.keys(want.verdicts).length === 3);
  if (doc && cat && want) {
    const res = crossCheck({ screens: [{ doc, label: "Screen__5_6" }], components: cat });
    const entries = res.coverage?.entries || [];
    const verdictOf = (setName: string): string | null => {
      const e = entries.find((x) => x.setName === setName);
      return !e ? null : e.matchedBy === "name" ? "matched" : e.ambiguous ? "ambiguous" : e.matchedBy === null ? "unmatched" : `by ${e.matchedBy}`;
    };
    const rows = new Map(matchByNameAndSignature(visibleInstances(doc, "Screen__5_6"), cat).rows.map((r) => [r.name, nameVerdict(r).status]));
    for (const [name, v] of Object.entries(want.verdicts)) {
      ok(`[DT27-1] '${name}': cross-check's coverage says ${v} (got ${verdictOf(name)}), the same as nameVerdict (${rows.get(name)})`, verdictOf(name) === v && rows.get(name) === v);
    }
    const bucket = (n: string) => entries.find((e) => e.setName === n)?.bucket;
    ok("[DT27-1] the buckets follow the verdicts: duplicate-definitions → nameOnly, signature mismatch → newWork, different-signatures tie → ambiguous",
      bucket("icon/check-circle") === "nameOnly" && bucket("Header") === "newWork" && bucket("Badge") === "ambiguous");
    const b: Partial<Record<CoverageBucket, number>> = res.coverage?.buckets || {};
    ok("[DT27-1] the buckets still sum to distinct", res.coverage?.distinct === 3 && Object.values(b).reduce((n: number, x: number) => n + x, 0) === 3);
    const e = (n: string) => entries.find((x) => x.setName === n);
    ok("[DT27-1] a name match carries component-match's evidence; unmatched/ambiguous entries say why",
      e("icon/check-circle")?.evidence === "name+no-props" && /no prop signature agrees/.test(e("Header")?.reason ?? "") && /DIFFERENT signatures/.test(e("Badge")?.reason ?? "") && e("Badge")?.candidates === 2);
    ok("[DT27-1] the ambiguous finding lists Badge, the name-matched one lists the check icon (not the mismatched Header)",
      (res.findings.find((f) => f.code === "ambiguous-component-name")?.components || []).map((c) => c.setName).join() === "Badge" &&
      (res.findings.find((f) => f.code === "name-matched-components")?.components || []).map((c) => c.setName).join() === "icon/check-circle");
  }
  // K-5: a name that exists only in components.library.json is no longer a name match (a key hit still is).
  const libOnly = crossCheck({ screens: [screen("S", [instance("2:1", "x", "icons/linear/book")])], components: DS_COMPONENTS, componentsLibrary: { components: [{ name: "icons/linear/book", key: "lib-icon", type: "COMPONENT" }] } });
  ok("[DT27-1/K-5] a library-only NAME is new work, not a name match", libOnly.coverage?.matchedByName === 0 && libOnly.coverage?.entries[0]?.bucket === "newWork");
}
{
  // [F44-c] every cross-check finding carries the id audit.ts gives it (finding-id.ts): `code` with no
  // node, `~2` for the second finding with the same base in one report.
  const vars = tokens({
    collections: [{ name: "Spacing", key: "screen-space", modes: ["Desktop"], default: "Desktop" }],
    variables: [
      { name: "Space 3", collection: "Spacing", key: "s-1", type: "FLOAT", values: { Desktop: 12 } },
      { name: "Full", collection: "Spacing", key: "s-2", type: "FLOAT", values: { Desktop: 4 } },
    ],
  });
  const res = crossCheck({ screens: [screen("S", [instance("2:1", "other-a", "Widget")])], variables: vars, tokens: DS_TOKENS, components: DS_COMPONENTS });
  const ids = res.findings.map((f) => f.id);
  ok("[F44-c] every finding has an id, and it is findingIds() over the report in its final order",
    res.findings.length > 3 && ids.every((x) => typeof x === "string") && JSON.stringify(ids) === JSON.stringify(findingIds(res.findings)));
  ok("[F44-c] ids are unique; a repeated code is `code` then `code~2`",
    new Set(ids).size === ids.length && ids.includes("token-name-collision") && ids.includes("token-name-collision~2"));
}
{
  // [F47-1] An export with two screens: both use Sidebar and Card, only A uses Grid; the project's map
  // already has Sidebar. Proposals are LABELLED — alreadyMapped (listed last), sharedWith — and the
  // confirm count drops the mapped one. Nothing is auto-confirmed and the severity does not change.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g14-f47-"));
  const put = (rel: string, doc: unknown): string => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(doc, null, 2)); return f; };
  const sidebar = (id: string): NodeInput => ({ type: "INSTANCE", id, name: "Sidebar", component: "State=Open", props: { State: "Open" }, mainComponent: { name: "State=Open", key: "s-sidebar-open", setKey: "s-sidebar", setName: "Sidebar" } });
  const plain = (id: string, name: string, key: string, props: ComponentPropValues): NodeInput => ({ type: "INSTANCE", id, name, props, mainComponent: { name, key } });
  const A = screenExport([{ type: "FRAME", id: "1:1", name: "A", children: [sidebar("1:2"), plain("1:3", "Grid", "s-grid", { "Rows#1:0": "3" }), plain("1:4", "Card", "s-card", { "Title#2:0": "x" })] }], { screen: "A", nodeId: "1:1" });
  const B = screenExport([{ type: "FRAME", id: "2:1", name: "B", children: [sidebar("2:2"), plain("2:3", "Card", "s-card", { "Title#2:0": "y" })] }], { screen: "B", nodeId: "2:1" });
  const fileA = put("design/export/pages/P/A__1_1.json", A);
  put("design/export/pages/P/B__2_1.json", B);
  put("design/export/pages/index.json", { pageDirs: [{ page: "P", dir: "P", index: "pages/P/index.json", layers: 2 }], layers: [
    { name: "A", id: "1:1", file: "pages/P/A__1_1.json" }, { name: "B", id: "2:1", file: "pages/P/B__2_1.json" }] });
  const CAT = catalog([
    { name: "Sidebar", id: "9:1", key: "cat-sidebar", type: "COMPONENT_SET", props: { State: { type: "VARIANT", options: ["Open", "Closed"] } } },
    { name: "Grid", id: "9:2", key: "cat-grid", type: "COMPONENT", props: { Rows: { type: "TEXT" } } },
    { name: "Card", id: "9:3", key: "cat-card", type: "COMPONENT", props: { Title: { type: "TEXT" } } },
  ]);
  put("design/export/design-system/components.local.json", CAT);
  const MAP = codeMap({ "s-sidebar": { figma: { name: "Sidebar", key: "cat-sidebar", id: "9:1" } } });
  put("design/codeconnect.local.json", MAP);
  const CLI = path.join(import.meta.dirname, "..", "design-to-code", "cross-check.ts");
  const r = spawnSync(process.execPath, [CLI, fileA, "--design-system", path.join(tmp, "design/export/design-system"), "--json"], { encoding: "utf8", cwd: tmp });
  const res = tryParse(r.stdout, isCrossCheckReport);
  const props = (res && res.componentProposals) || [];
  const p = (n: string) => props.find((x) => x.name === n);
  ok("[F47-1] the re-keyed screen proposes Sidebar, Grid and Card", props.length === 3 && !!p("Sidebar") && !!p("Grid") && !!p("Card"));
  ok("[F47-1] Sidebar is alreadyMapped (the default design/codeconnect.local.json has its instance key) and on 1 other screen",
    p("Sidebar")?.alreadyMapped === true && p("Sidebar")?.sharedWith === 1);
  ok("[F47-1] Grid is this screen only (sharedWith 0, not mapped); Card is shared with 1", p("Grid")?.sharedWith === 0 && p("Grid")?.alreadyMapped === undefined && p("Card")?.sharedWith === 1);
  ok("[F47-1] order: shared to confirm, then screen-only, then already mapped", props.map((x) => x.name).join() === "Card,Grid,Sidebar");
  const rk = res && res.findings.find((f) => f.code === "catalog-rekeyed");
  ok("[F47-1] the catalog-rekeyed confirm count excludes the mapped one (2, not 3), and the severity is unchanged",
    !!rk && rk.severity === "warning" && /^2 component\(s\) match/.test(rk.confirm ?? "") && /3 proposals, 1 already mapped .* confirm only the other 2/.test(rk.message));
  ok("[F47-1] nothing is auto-confirmed", props.every((x) => x.confirmed === false));
  const md = spawnSync(process.execPath, [CLI, fileA, "--design-system", path.join(tmp, "design/export/design-system")], { encoding: "utf8", cwd: tmp }).stdout;
  ok("[F47-1] the markdown splits 'shared — confirm once' / 'this screen only' / 'already mapped'",
    /### Shared with other exported screens — confirm once \(1\)[\s\S]*`Card`[\s\S]*### This screen only \(1\)[\s\S]*`Grid`[\s\S]*### Already in the component map — nothing to confirm \(1\)[\s\S]*`Sidebar`/.test(md));
  // --map names the map explicitly; with no map anywhere there is no alreadyMapped label at all.
  const noMap = tryParse(spawnSync(process.execPath, [CLI, fileA, "--design-system", path.join(tmp, "design/export/design-system"), "--json"], { encoding: "utf8", cwd: path.join(tmp, "design/export") }).stdout, isCrossCheckReport);
  ok("[F47-1] no map found → no alreadyMapped label, confirm count 3", !!noMap && (noMap.componentProposals || []).every((x) => x.alreadyMapped === undefined) && /^3 component/.test(noMap.findings.find((f) => f.code === "catalog-rekeyed")?.confirm ?? ""));
  const explicit = tryParse(spawnSync(process.execPath, [CLI, fileA, "--design-system", path.join(tmp, "design/export/design-system"), "--map", path.join(tmp, "design/codeconnect.local.json"), "--json"], { encoding: "utf8", cwd: path.join(tmp, "design/export") }).stdout, isCrossCheckReport);
  ok("[F47-1] --map <file> labels the same way from any cwd", !!explicit && (explicit.componentProposals || []).find((x) => x.name === "Sidebar")?.alreadyMapped === true);
  // Review 1 M-2: the map-bootstrap scaffold writes a stub for every CATALOG component, keyed by the catalog key.
  // None of the re-keyed screen's instance keys are in it, so nothing resolves through it: no proposal is
  // "already mapped" and the confirm count stays 3.
  const stub = put("stub/codeconnect.local.json", codeMap({
    "cat-sidebar": { figma: { name: "Sidebar", key: "cat-sidebar", id: "9:1" } },
    "cat-grid": { figma: { name: "Grid", key: "cat-grid", id: "9:2" } },
    "cat-card": { figma: { name: "Card", key: "cat-card", id: "9:3" } },
  }));
  const stubbed = tryParse(spawnSync(process.execPath, [CLI, fileA, "--design-system", path.join(tmp, "design/export/design-system"), "--map", stub, "--json"], { encoding: "utf8", cwd: tmp }).stdout, isCrossCheckReport);
  const stubProps = (stubbed && stubbed.componentProposals) || [];
  ok("[F47-1 M-2] a catalog-keyed stub map labels nothing alreadyMapped", stubProps.length === 3 && stubProps.every((x) => x.alreadyMapped === undefined));
  ok("[F47-1 M-2] …and the confirm count stays 3", /^3 component/.test(stubbed?.findings.find((f) => f.code === "catalog-rekeyed")?.confirm ?? ""));
  // In-process: siblings are a thunk, read only when there are proposals.
  let called = 0;
  crossCheck({ screens: [{ doc: A, label: "A" }], components: catalog([{ name: "Other", key: "k", type: "COMPONENT" }]), siblings: () => { called++; return [{ doc: B, label: "B" }]; } });
  ok("[F47-1] the other screens are not read when there is nothing to label", called === 0);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- F-126: one screen, two modes
console.log("cross-check — F-126: colour bindings from collections resolved in different modes:");
{
  // Two theme collections sharing Dark/Light (the screen's own resolves Dark, a starter kit's still Light),
  // and a brand collection on its own vocabulary. Every collection is in resolvedModes, as Figma writes it.
  const vars = tokens({
    collections: [
      { name: "Theme", key: "c-a", modes: ["Dark", "Light"], default: "Dark" },
      { name: "Kit", key: "c-b", modes: ["Light", "Dark"], default: "Light" },
      { name: "Brand", key: "c-c", modes: ["Brand 1", "Brand 2"], default: "Brand 1" },
    ],
    variables: [
      { name: "Surface/Page", collection: "Theme", key: "a1", type: "COLOR", values: { Dark: "#121319", Light: "#ffffff" } },
      { name: "Text/Main", collection: "Theme", key: "a2", type: "COLOR", values: { Dark: "#ffffff", Light: "#121319" } },
      { name: "Kit/On Surface", collection: "Kit", key: "b1", type: "COLOR", values: { Light: "#1d1b20", Dark: "#e6e0e9" } },
      { name: "Brand/Accent", collection: "Brand", key: "c1", type: "COLOR", values: { "Brand 1": "#ff8800", "Brand 2": "#0088ff" } },
    ],
  });
  const doc = (modes: Record<string, string>, children: NodeInput[]) => screenExport([
    { type: "FRAME", id: "1:1", name: "Settings", resolvedModes: modes, tokens: { fills: "Surface/Page" }, children: [text("2:1", "Inter", null, "Text/Main"), ...children] },
  ], { screen: "Settings" });
  const ALL = { Theme: "Dark", Kit: "Light", Brand: "Brand 1" };
  const kitText: NodeInput = { type: "TEXT", id: "3:1", name: "Btn Text", text: "Save", font: { family: "Inter", size: 14 }, fills: [{ type: "solid", color: "#1d1b20", tokens: { color: "Kit/On Surface" } }] };
  const res = crossCheck({ screens: [{ doc: doc(ALL, [kitText]), label: "Settings" }], variables: vars });
  const f = res.findings.find((x) => x.code === "mixed-mode-bindings");
  const kitRow = f?.bindings?.find((b) => b.collection === "Kit");
  ok("[F126-1] a colour bound from a collection resolved Light on a Dark screen is a warning with a confirm question",
    f?.severity === "warning" && /'Kit' in 'Light'/.test(f.message) && /in 'Dark'/.test(f.message) && /'Kit\/On Surface' on 'Btn Text'/.test(f.message) && /follow 'Dark'/.test(f.confirm ?? ""));
  ok("[F126-1] bindings[] names the minority collection's tokens and nodes, and the majority's mode",
    kitRow?.mode === "Light" && kitRow.tokens.join() === "Kit/On Surface" && kitRow.nodes.join() === "3:1" && f?.bindings?.find((b) => b.collection === "Theme")?.mode === "Dark");
  ok("[F126-1] nodeId is the first node binding the minority collection", f?.nodeId === "3:1");
  ok("[F126-2] a collection the screen RESOLVES in Light but binds nothing from is not a mix (every collection is in resolvedModes)",
    !has(crossCheck({ screens: [{ doc: doc(ALL, []), label: "Settings" }], variables: vars }), "mixed-mode-bindings"));
  const brandText: NodeInput = { type: "TEXT", id: "4:1", name: "Tag", text: "New", font: { family: "Inter", size: 14 }, tokens: { fills: "Brand/Accent" } };
  ok("[F126-3] a bound collection on another vocabulary (Brand 1 / Brand 2) is not a mix",
    !has(crossCheck({ screens: [{ doc: doc(ALL, [brandText]), label: "Settings" }], variables: vars }), "mixed-mode-bindings"));
  ok("[F126-4] the same binding with the kit pinned to Dark is not a mix",
    !has(crossCheck({ screens: [{ doc: doc({ ...ALL, Kit: "Dark" }, [kitText]), label: "Settings" }], variables: vars }), "mixed-mode-bindings"));
  // M-1 (review 1): the majority is chosen per mode vocabulary — Brand 1 / Brand 2 bindings, as many as the theme's or
  // more, never mask the Dark/Light mix (they used to win the vote, and no Dark/Light collection declares 'Brand 1').
  for (const n of [2, 3]) {
    const brands = Array.from({ length: n }, (_, i): NodeInput => ({ ...brandText, id: `4:${i + 1}` }));
    const m = crossCheck({ screens: [{ doc: doc(ALL, [kitText, ...brands]), label: "Settings" }], variables: vars }).findings.filter((x) => x.code === "mixed-mode-bindings");
    ok(`[F126-3 / M-1] ${n} Brand binding(s) beside 2 Theme ones: the Theme Dark / Kit Light mix is still ONE warning, Brand out of it`,
      m.length === 1 && /'Kit' in 'Light'/.test(m[0]?.message ?? "") && !(m[0]?.bindings ?? []).some((x) => x.collection === "Brand"));
  }
}

// ---------------------------------------------------------------- DT-63: token pairs in the rendered mode
console.log("cross-check — DT-63: failing token pairs in the RENDERED mode, one table per run:");
{
  const vars = tokens({
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }, { name: "Prim", key: "c2", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [
      { name: "Gray/900", collection: "Prim", key: "p1", type: "COLOR", values: { "Mode 1": "#121319" } },
      { name: "Bg/Page", collection: "Sem", key: "s1", type: "COLOR", values: { Dark: { aliasOf: "Gray/900" }, Light: "#ffffff" } },
      { name: "Bg/Input", collection: "Sem", key: "s2", type: "COLOR", values: { Dark: "#1d1d1f", Light: "#f4f4f4" } },
      { name: "Border", collection: "Sem", key: "s3", type: "COLOR", values: { Dark: "#46464f", Light: "#c0c0c8" } },
      { name: "Accent", collection: "Sem", key: "s4", type: "COLOR", values: { Dark: "#c6bfff", Light: "#4b3fcf" } },
      { name: "Text/Main", collection: "Sem", key: "s5", type: "COLOR", values: { Dark: "#ffffff", Light: "#121319" } },
      { name: "Bg/Card", collection: "Sem", key: "s6", type: "COLOR", values: { Dark: "#ffffff", Light: "#ffffff" } },
      { name: "Bg/Soft", collection: "Sem", key: "s7", type: "COLOR", values: { Dark: "#e0e0e0", Light: "#e0e0e0" } },
      { name: "Border/Strong", collection: "Sem", key: "s8", type: "COLOR", values: { Dark: "#8a8a8a", Light: "#8a8a8a" } },
    ],
  });
  const STROKE = { colors: ["#46464f"], weight: 1, align: "inside" as const };
  const field = (id: string, extra: Partial<NodeInput> = {}): NodeInput => ({
    type: "INSTANCE", id, name: "Input Field", mainComponent: { name: "State=Default", key: "fk", setKey: "fs", setName: "Input Field" },
    tokens: { fills: "Bg/Input", strokes: "Border" }, strokes: STROKE,
    fills: [{ type: "solid", color: "#1d1d1f", tokens: { color: "Bg/Input" } }], ...extra,
  });
  // the accent button: stroke token == its own fill token, and that fill stands out on the page (≥ 3:1)
  const button: NodeInput = { type: "INSTANCE", id: "9:1", name: "Button", tokens: { fills: "Accent", strokes: "Accent" }, strokes: { colors: ["#c6bfff"], weight: 1 }, fills: [{ type: "solid", color: "#c6bfff", tokens: { color: "Accent" } }] };
  const page = (label: string, id: string, children: NodeInput[]): CrossCheckScreen => ({
    doc: screenExport([{ type: "FRAME", id, name: label, resolvedModes: { Sem: "Dark", Prim: "Mode 1" }, tokens: { fills: "Bg/Page" }, children }], { screen: label }),
    label,
  });
  // a soft field on a white card: its border passes against the CARD (3.4:1) but not against its own fill
  // (2.6:1), and the fill does not draw the boundary (1.3:1) — WCAG 1.4.11 asks about the card, so no row
  const card: NodeInput = { type: "FRAME", id: "8:1", name: "Card", tokens: { fills: "Bg/Card" }, children: [
    field("8:2", { tokens: { fills: "Bg/Soft", strokes: "Border/Strong" }, fills: [{ type: "solid", color: "#e0e0e0", tokens: { color: "Bg/Soft" } }] }),
  ] };
  // a filled switch whose dim border fails on the page, but whose fill stands out 3:1 — the fill is the boundary
  const chip: NodeInput = { type: "INSTANCE", id: "9:2", name: "Switch", tokens: { fills: "Accent", strokes: "Border" }, strokes: STROKE, fills: [{ type: "solid", color: "#c6bfff", tokens: { color: "Accent" } }] };
  // D126: a badge's border is decoration, not a control's boundary — no stroke row however dim
  const badge: NodeInput = { type: "INSTANCE", id: "9:3", name: "Badge", mainComponent: { name: "Type=Neutral", key: "bk", setKey: "bs", setName: "Badge" }, tokens: { strokes: "Border" }, strokes: STROKE };
  const A = page("Form A", "1:1", [field("1:2"), button, chip, badge, card, text("1:3", "Inter", null, "Text/Main")]);
  const B = page("Form B", "2:1", [field("2:2"), field("2:3", { props: { State: "Disabled" }, mainComponent: { name: "State=Disabled", key: "fk2", setKey: "fs", setName: "Input Field" } })]);
  const res = crossCheck({ screens: [A, B], variables: vars });
  const all = res.findings.filter((x) => x.code === "token-pair-contrast");
  const rows = all[0]?.tokenPairs ?? [];
  const row = rows[0];
  ok("[DT63-T1] two screens with the same stroke/background pair -> ONE info, ONE row covering both screens",
    all.length === 1 && all[0]?.severity === "info" && rows.length === 1 && row?.screens.join() === "Form A,Form B");
  ok("[DT63-T1] the row: non-text, the border against the PAGE around the field (not the field's own fill), in the rendered mode, 1.99:1 < 3:1",
    row?.kind === "non-text" && row.fg === "Border" && row.bg === "Bg/Page" && row.mode === "Dark" && row.ratio === 1.99 && row.required === 3);
  ok("[DT63-T1] nodes: the two enabled fields only (the Disabled variant is exempt)", row?.nodes.join() === "1:2,2:2");
  ok("[DT63-T2] a stroke equal to its own fill, on a page that fill contrasts with, is no row (WCAG 1.4.11: the colour outside the control)",
    !rows.some((r) => r.fg === "Accent"));
  ok("[DT63-T2] a dim border around a fill that contrasts 3:1 with the page is no node of the row (the fill rescues it)",
    !(row?.nodes ?? []).includes("9:2"));
  ok("[DT63-T2/D126] a badge's dim border is no row (stroke rows cover inputs, selects and toggles only)",
    !(row?.nodes ?? []).includes("9:3") && rows.length === 1);
  ok("[DT63-T2] a border that passes against the card around it is no row, though it fails against its own fill",
    !rows.some((r) => r.fg === "Border/Strong"));
  ok("[DT63-T3] the message is a question once per pair, and the field `pairs` stays derived-mode-contrast's",
    /^1 token pair\(s\) fail WCAG in the rendered mode\(s\) — ask the designer once per pair: stroke 'Border' on 'Bg\/Page' \(Dark\) 1\.99:1 < 3:1 — 2 screen\(s\)/.test(all[0]?.message ?? "") && all[0]?.pairs === undefined);
  ok("[DT63-T3] the cross-check markdown prints the table", /## Token pairs below WCAG in the rendered modes[\s\S]*\| non-text \| `Border` \| `Bg\/Page` \| Dark \| 1\.99:1 \| 3:1 \| 2: Form A, Form B \|/.test(toMarkdown(res)));
  // Text pairs: 4.5:1, 3:1 for large text (≥ 24px).
  const dim: NodeInput = { type: "TEXT", id: "5:1", name: "Hint", text: "Search", font: { family: "Inter", size: 14 }, tokens: { fills: "Border" } };
  const big: NodeInput = { type: "TEXT", id: "5:2", name: "Title", text: "Search", font: { family: "Inter", size: 28 }, tokens: { fills: "Accent" } };
  const t = crossCheck({ screens: [page("Form C", "3:1", [dim, big])], variables: vars }).findings.find((x) => x.code === "token-pair-contrast")?.tokenPairs ?? [];
  ok("[DT63-T4] text on its backdrop at 4.5:1 is a text row; large text that passes 3:1 is none",
    t.length === 1 && t[0]?.kind === "text" && t[0].fg === "Border" && t[0].required === 4.5);
  // The per-screen audit does not merge cross-file info: the run's table is not doubled into its findings.
  // Real-shaped: what the CLI passes — the screen's own .vars.json slice, the merged variables.json and the
  // design-system dir's tokens; the cross-file pass's warnings ARE merged, its info never.
  for (const [how, opts] of [["variables only", { variables: vars }], ["--design-system", { variables: vars, designSystem: { tokens: vars } }]] as const) {
    const au = audit([{ doc: A.doc ?? null, label: "Form A", vars }], opts);
    const cf = (au.crossFile && au.crossFile.findings) || [];
    ok(`[DT63-T5] audit (${how}): the table is in crossFile as info only, never a merged audit finding`,
      au.findings.every((x) => x.code !== "token-pair-contrast") && cf.filter((x) => x.code === "token-pair-contrast").map((x) => x.severity).join() === "info");
  }
}

// ---------------------------------------------------------------- review 1 of groups 18+19, fix pass 1 (D127)
console.log("cross-check — token pairs, fix pass 1 (unknown backdrops, the colour outside the control, rendered mode, large text, disabled):");
{
  const vars = tokens({
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Bg/Page", collection: "Sem", key: "s1", type: "COLOR", values: { Dark: "#121319", Light: "#ffffff" } },
      { name: "Bg/Card", collection: "Sem", key: "s2", type: "COLOR", values: { Dark: "#1d1d1f", Light: "#ffffff" } },
      { name: "Bg/Input", collection: "Sem", key: "s3", type: "COLOR", values: { Dark: "#1d1d1f", Light: "#f4f4f4" } },
      { name: "Bg/Soft", collection: "Sem", key: "s4", type: "COLOR", values: { Dark: "#e0e0e0", Light: "#e0e0e0" } },
      { name: "Bg/White", collection: "Sem", key: "s5", type: "COLOR", values: { Dark: "#ffffff", Light: "#ffffff" } },
      { name: "Static/Black", collection: "Sem", key: "s6", type: "COLOR", values: { Dark: "#000000", Light: "#000000" } },
      { name: "Text/Muted", collection: "Sem", key: "s7", type: "COLOR", values: { Dark: "#ffffff", Light: "#c0c0c8" } },
      { name: "Text/Faint", collection: "Sem", key: "s8", type: "COLOR", values: { Dark: "#2a2a2a", Light: "#121319" } },
      { name: "Text/Large", collection: "Sem", key: "s9", type: "COLOR", values: { Dark: "#7a7a85", Light: "#7a7a85" } },
      { name: "Border", collection: "Sem", key: "s10", type: "COLOR", values: { Dark: "#46464f", Light: "#c0c0c8" } },
      { name: "Border/Strong", collection: "Sem", key: "s11", type: "COLOR", values: { Dark: "#8a8a8a", Light: "#8a8a8a" } },
    ],
  });
  const solid = (color: string, token?: string) => ({ type: "solid" as const, color, ...(token ? { tokens: { color: token } } : {}) });
  const label = (id: string, token: string, size = 14): NodeInput => ({ type: "TEXT", id, name: "Label", text: "Roles", font: { family: "Inter", size }, tokens: { fills: token } });
  const scr = (name: string, children: NodeInput[], mode = "Dark"): CrossCheckScreen => ({
    doc: screenExport([{ type: "FRAME", id: "1:1", name, resolvedModes: { Sem: mode }, tokens: { fills: "Bg/Page" }, fills: [solid(mode === "Dark" ? "#121319" : "#ffffff", "Bg/Page")], children }], { screen: name }),
    label: name,
  });
  const pairs = (...screens: CrossCheckScreen[]) => crossCheck({ screens, variables: vars }).findings.find((x) => x.code === "token-pair-contrast")?.tokenPairs ?? [];
  const frame = (id: string, fills: NonNullable<NodeInput["fills"]>, children: NodeInput[], extra: Partial<NodeInput> = {}): NodeInput => ({ type: "FRAME", id, name: "Selected item", fills, children, ...extra });

  // H-1: an untokenised gradient / raw / translucent fill between the text and the nearest token backdrop makes it unknown.
  const grad = { type: "gradient" as const, kind: "GRADIENT_LINEAR" as const, stops: [{ pos: 0, color: "#c6bfff" }, { pos: 1, color: "#ffffff" }] };
  ok("[H-1] black text on a gradient highlight inside a dark token page → no row (the audit's contrast-manual covers it)", pairs(scr("Side menu", [frame("2:1", [grad], [label("2:2", "Static/Black")])])).length === 0);
  ok("[H-1] …nor on a raw, untokenised #f4f4f4 card", pairs(scr("Side menu", [frame("2:1", [solid("#f4f4f4")], [label("2:2", "Static/Black")])])).length === 0);
  ok("[H-1] …nor on a translucent token-bound fill (the composite is no token's value)", pairs(scr("Side menu", [frame("2:1", [solid("#1d1d1f80", "Bg/Card")], [label("2:2", "Static/Black")])])).length === 0);
  const card = pairs(scr("Side menu", [frame("2:1", [solid("#1d1d1f", "Bg/Card")], [label("2:2", "Static/Black")])]));
  ok("[H-1] control: on an opaque token-bound card the pair is judged against the CARD", card.length === 1 && card[0]?.fg === "Static/Black" && card[0].bg === "Bg/Card");
  ok("[H-1] a fully transparent raw fill paints nothing: the page token stays the backdrop",
    pairs(scr("Side menu", [frame("2:1", [solid("#f4f4f400")], [label("2:2", "Static/Black")])]))[0]?.bg === "Bg/Page");
  // …and the derived-mode check walks the same backdrop (walkWithBg): Text/Muted fails on the page only in Light.
  const derived = (kids: NodeInput[]) => crossCheck({ screens: [scr("Side menu", kids)], variables: vars }).findings.some((x) => x.code === "derived-mode-contrast");
  ok("[H-1] derived-mode-contrast: a text on the page is judged in the undrawn Light mode", derived([label("2:2", "Text/Muted")]));
  ok("[H-1] derived-mode-contrast: the same text on a gradient highlight is not (its backdrop is unknown)", !derived([frame("2:1", [grad], [label("2:2", "Text/Muted")])]));

  // M-6: the RENDERED mode is the root's resolvedModes entry, not the collection's default.
  const light = pairs(scr("Profile", [label("3:1", "Text/Muted"), label("3:2", "Text/Faint")], "Light"));
  ok("[M-6] a Light screen (default Dark): the pair failing only in Light is a row in mode 'Light' (#c0c0c8 on #ffffff 1.81:1)",
    light.length === 1 && light[0]?.fg === "Text/Muted" && light[0].mode === "Light" && light[0].ratio === 1.81);
  ok("[M-6] …and the pair failing only in Dark is absent", !light.some((p) => p.fg === "Text/Faint"));

  // L-1 / C6: large text needs 3:1 — a 28px label at 4.37:1 passes, the same label at 14px does not.
  ok("[L-1 C6] large text (28px) at 4.37:1 is no row; at 14px it is one (needs 4.5:1)",
    pairs(scr("Profile", [label("3:3", "Text/Large", 28)])).length === 0 && pairs(scr("Profile", [label("3:3", "Text/Large", 14)]))[0]?.required === 4.5);

  // M-2: the border vs the colour OUTSIDE the control, also when the fill is on the instance and the border on an inner frame.
  const field = (id: string, instFill: string, fillTok: string, strokeTok: string, strokeHex: string, extra: Partial<NodeInput> = {}): NodeInput => ({
    type: "INSTANCE", id, name: "Input Field", mainComponent: { name: "State=Default", key: "fk", setKey: "fs", setName: "Input Field" },
    tokens: { fills: fillTok }, fills: [solid(instFill, fillTok)], ...extra,
    children: [{ type: "FRAME", id: `I${id};1`, name: "Container", tokens: { strokes: strokeTok }, strokes: { colors: [strokeHex], weight: 1, align: "inside" } }],
  });
  const onCard = frame("4:1", [solid("#ffffff", "Bg/White")], [field("4:2", "#e0e0e0", "Bg/Soft", "Border/Strong", "#8a8a8a")], { name: "Card" });
  ok("[M-2] split layers: a border that passes against the white card around the control (3.4:1) but not against the instance's own fill (2.6:1) is no row",
    !pairs(scr("Form", [onCard])).some((p) => p.fg === "Border/Strong"));
  const dark = pairs(scr("Form", [field("4:3", "#1d1d1f", "Bg/Input", "Border", "#46464f")]));
  ok("[M-2] split layers: a border that fails is a row against the PAGE (the colour outside), never the instance's Bg/Input",
    dark.length === 1 && dark[0]?.fg === "Border" && dark[0].bg === "Bg/Page" && dark[0].nodes.join() === "I4:3;1");
  ok("[M-2] split layers: the instance's fill reaching 3:1 against the page draws the boundary → no row",
    pairs(scr("Form", [field("4:4", "#ffffff", "Bg/White", "Border", "#46464f")])).length === 0);

  // M-5: 'Disabled=True' is a disabled variant here too (one helper with the audit).
  ok("[M-5] a 'Size=M, Disabled=True' field (props Disabled: \"True\") is exempt",
    pairs(scr("Form", [field("4:5", "#1d1d1f", "Bg/Input", "Border", "#46464f", { props: { Size: "M", Disabled: "True" }, mainComponent: { name: "Size=M, Disabled=True", key: "fk3", setKey: "fs", setName: "Input Field" } })])).length === 0);
  // L-2: a fully transparent stroke paints no border.
  ok("[L-2] a 0-opacity border (#46464f00) is no row", pairs(scr("Form", [field("4:6", "#1d1d1f", "Bg/Input", "Border", "#46464f00")])).length === 0);
}

report();
