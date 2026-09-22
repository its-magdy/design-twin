// Offline tests for design-to-code/cross-check.js — the JOIN between a screen and the design system.
//
// Every fixture here is a miniature of a defect the live run hit by hand and the tooling missed:
// a duplicated file that re-keys every collection, a catalog that covers 0% of the screen, two
// libraries whose token names collide on different values, a text style that differs by one capital
// letter, a radius of a billion, a Dark-only export of a two-mode system.
// Run with:  node test/cross-check.test.js
const { crossCheck, toMarkdown } = require("../design-to-code/cross-check.js");
const { screenCoverage } = require("../design-to-code/drift-lint.js");
const { ok, report } = require("./assert");

const has = (res, code) => res.findings.some((f) => f.code === code);
const get = (res, code) => res.findings.find((f) => f.code === code);
const sev = (res, code) => (get(res, code) || {}).severity;

// ---------------------------------------------------------------- fixtures
const instance = (id, setKey, setName, props) => ({
  type: "INSTANCE", id, name: setName, props: props || {},
  mainComponent: { name: setName, key: setKey + "-v", setKey, setName },
});
const text = (id, family, style, token) => ({
  type: "TEXT", id, font: { family, size: 14 }, styles: style ? { text: style } : undefined,
  tokens: token ? { fills: token } : undefined,
});
const screen = (label, children) => ({
  doc: { exportedAt: "2026-09-22T00:00:00Z", screen: label, nodes: [{ type: "FRAME", id: "1:1", resolvedModes: { Sem: "Dark" }, children }] },
  label,
});

const DS_TOKENS = {
  collections: [
    { name: "Sem", key: "ds-sem", modes: ["Dark", "Light"], default: "Dark" },
    { name: "Spacing", key: "ds-space", modes: ["Mode 1"], default: "Mode 1" },
  ],
  variables: [
    { name: "Text/Main", collection: "Sem", key: "ds-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } },
    { name: "Space 3", collection: "Spacing", key: "ds-k2", type: "FLOAT", values: { "Mode 1": 16 } },
    { name: "Full", collection: "Spacing", key: "ds-k3", type: "FLOAT", values: { "Mode 1": 1000000000 } },
  ],
};
const DS_COMPONENTS = {
  components: [
    { name: "Button", key: "ds-btn", type: "COMPONENT_SET", props: { "Btn Text": { type: "TEXT" } } },
    { name: "Header", key: "ds-hdr", type: "COMPONENT_SET", props: {} },
    { name: "Header", key: "ds-hdr2", type: "COMPONENT_SET", props: {} },
  ],
};
const DS_TEXT_STYLES = { styles: [{ name: "Medium/14 medium", font: "Poppins", size: 14 }] };

// ---------------------------------------------------------------- a duplicated file re-keys everything
console.log("cross-check — the screen's token library vs the design system's:");
{
  // Same collection NAME, same values, different key: the signature of "(Copy)".
  const duplicated = {
    collections: [{ name: "Sem", key: "screen-sem", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [{ name: "Text/Main", collection: "Sem", key: "screen-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } }],
  };
  const res = crossCheck({ screens: [screen("S", [text("2:1", "Poppins", null, "Text/Main")])], variables: duplicated, tokens: DS_TOKENS });
  ok("[tokens] a screen whose collections are ALL re-keyed is a blocker, not a warning", sev(res, "foreign-token-library") === "blocker");
  ok("[tokens] and the message names the duplicated-file cause rather than just 'not found'",
    /DUPLICATED Figma file/.test(get(res, "foreign-token-library").message));
  ok("[tokens] it names the ONE command that can attribute a collection to a library",
    /list libraries/.test(get(res, "foreign-token-library").message));
  ok("[tokens] identical values under a different key are NOT reported as a value conflict",
    !has(res, "token-name-collision"));
}
{
  const same = {
    collections: [{ name: "Sem", key: "ds-sem", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [{ name: "Text/Main", collection: "Sem", key: "ds-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } }],
  };
  const res = crossCheck({ screens: [screen("S", [])], variables: same, tokens: DS_TOKENS });
  ok("[tokens] a screen that really does use the design system's collections says so",
    has(res, "token-library-matches") && !has(res, "foreign-token-library"));
}

// ---------------------------------------------------------------- name collides, value differs
console.log("cross-check — two libraries, one name, two values:");
{
  // The live case exactly: `(Space 3)`=12 on Desktop vs `Space 3`=16 on "Mode 1". No mode name is
  // shared, so any comparison that needs aligned modes reports nothing — and this is the single most
  // dangerous collision there is, because a slugger maps both onto one custom property.
  const vars = {
    collections: [{ name: "Spacing", key: "screen-space", modes: ["Desktop", "Tablet"], default: "Desktop" }],
    variables: [{ name: "(Space 3)", collection: "Spacing", key: "screen-k2", type: "FLOAT", values: { Desktop: 12, Tablet: 8 } }],
  };
  const res = crossCheck({ screens: [screen("S", [])], variables: vars, tokens: DS_TOKENS });
  ok("[collision] a punctuation-only name twin with disjoint values is a blocker", sev(res, "token-name-collision") === "blocker");
  ok("[collision] the message carries BOTH values so the reader can pick", /12/.test(get(res, "token-name-collision").message) && /16/.test(get(res, "token-name-collision").message));
  ok("[collision] and says why no per-mode comparison was possible",
    /no mode name is shared/.test(get(res, "token-name-collision").message));
}
{
  // Aliases that point at the same target agree, even across libraries — the common, safe case. An
  // early version called every re-keyed variable a conflict, which would have cried wolf on the whole file.
  const vars = {
    collections: [{ name: "Sem", key: "screen-sem", modes: ["Dark"], default: "Dark" }],
    variables: [{ name: "Text/Main", collection: "Sem", key: "s1", type: "COLOR", values: { Dark: { aliasOf: "Gray/900" } } }],
  };
  const ds = { collections: DS_TOKENS.collections, variables: [{ name: "Text/Main", collection: "Sem", key: "d1", type: "COLOR", values: { Dark: { aliasOf: "Gray/900" }, Light: { aliasOf: "Gray/0" } } }] };
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
  ok("[coverage] 0% by key is a BLOCKER, not an empty success", sev(res, "catalog-covers-nothing") === "blocker");
  ok("[coverage] it counts distinct components, not instances", res.coverage.distinct === 2 && res.coverage.instances === 3);
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
    sev(res, "partial-catalog-coverage") === "warning" && res.coverage.localPct === 50);
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
    res.coverage.matchedByKey === 1 && res.coverage.matchedByLocalKey === 0 && res.coverage.localPct === 0);
  ok("[coverage] and the blocker still fires, saying what the library hit actually means",
    sev(res, "catalog-covers-nothing") === "blocker" && /same third-party set/.test(get(res, "catalog-covers-nothing").message));
}
{
  // Name fallback: a unique name with overlapping props is a LEAD. An ambiguous one is a coin flip
  // and is deliberately left unmatched — `Header` exists twice in the catalog.
  const res = crossCheck({
    screens: [screen("S", [instance("2:1", "x", "Button", { "Btn Text": "Go" }), instance("2:2", "y", "Header")])],
    components: DS_COMPONENTS,
  });
  ok("[coverage] a unique name + prop overlap is offered as an unverified lead", res.coverage.matchedByName === 1);
  ok("[coverage] the lead is reported ONCE for the whole set, not once per component",
    res.findings.filter((f) => f.code === "name-matched-components").length === 1);
  ok("[coverage] and every lead carries verified:false", get(res, "name-matched-components").components.every((c) => c.verified === false));
  ok("[coverage] an AMBIGUOUS name is left unmatched, not guessed",
    res.coverage.ambiguousName === 1 && has(res, "ambiguous-component-name"));
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
  ok("[styles] a case-only near-miss is a BLOCKER, not a missing style", sev(res, "text-style-near-miss") === "blocker");
  ok("[styles] and it prints both spellings side by side",
    /'Medium\/14 Medium' vs 'Medium\/14 medium'/.test(get(res, "text-style-near-miss").message));
}

// ---------------------------------------------------------------- sentinels and single-mode exports
console.log("cross-check — sentinel values and missing modes:");
{
  const res = crossCheck({ screens: [screen("S", [])], tokens: DS_TOKENS, variables: DS_TOKENS });
  ok("[sentinel] a radius of 1e9 is reported as a sentinel, not a measurement", has(res, "sentinel-token-value"));
  ok("[sentinel] it is reported ONCE even though both inputs carry the same variable",
    get(res, "sentinel-token-value").tokens.length === 1);
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

// ---------------------------------------------------------------- the mode nobody ever saw
console.log("cross-check — contrast in a mode that was derived, not drawn:");
{
  // The live case: `Backgrounds/Side menu` stays a DARK surface in Light while the sidebar's own
  // label token flips to a dark gray, so the derived Light sidebar's nav labels are near-invisible.
  // Mechanically correct, visually broken, and nothing in the toolchain looked.
  const vars = {
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Backgrounds/Side menu", collection: "Sem", key: "b1", type: "COLOR", values: { Dark: "#121319", Light: "#2b2b4f" } },
      { name: "Neutrals/Neutral 500", collection: "Sem", key: "t1", type: "COLOR", values: { Dark: "#d4d4d4", Light: "#46464f" } },
    ],
  };
  const sidebar = {
    type: "FRAME", id: "1:1", name: "Side menu", resolvedModes: { Sem: "Dark" }, tokens: { fills: "Backgrounds/Side menu" },
    children: [text("2:1", "Poppins", null, "Neutrals/Neutral 500")],
  };
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [sidebar] }, label: "S" }], variables: vars });
  ok("[contrast] a derived mode's unreadable pair is a BLOCKER", sev(res, "derived-mode-contrast") === "blocker");
  ok("[contrast] it names the mode that was never drawn, not the one that was",
    get(res, "derived-mode-contrast").mode === "Light");
  ok("[contrast] and reports the actual ratio, not a verdict",
    get(res, "derived-mode-contrast").pairs[0].ratio < 4.5 && get(res, "derived-mode-contrast").pairs[0].ratio > 1);
  ok("[contrast] the fix it asks for is a designer answer or a real frame, never an invented override",
    /Do not invent an override/.test(get(res, "derived-mode-contrast").message));
}
{
  // The mode that WAS exported already has a strictly better check in audit.js, which walks the real
  // composited backgrounds. Reporting it here just re-raises that check's known false positives.
  const vars = {
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Bg", collection: "Sem", key: "b1", type: "COLOR", values: { Dark: "#121319", Light: "#ffffff" } },
      { name: "Fg", collection: "Sem", key: "t1", type: "COLOR", values: { Dark: "#131320", Light: "#000000" } },
    ],
  };
  const frame = { type: "FRAME", id: "1:1", name: "F", resolvedModes: { Sem: "Dark" }, tokens: { fills: "Bg" }, children: [text("2:1", "Poppins", null, "Fg")] };
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [frame] }, label: "S" }], variables: vars });
  ok("[contrast] the mode that WAS rendered is left to the audit's composited check", !has(res, "derived-mode-contrast"));
}
{
  const vars = {
    collections: [{ name: "Sem", key: "c1", modes: ["Only"], default: "Only" }],
    variables: [{ name: "Bg", collection: "Sem", key: "b1", type: "COLOR", values: { Only: "#000000" } }],
  };
  const frame = { type: "FRAME", id: "1:1", name: "F", resolvedModes: { Sem: "Only" }, tokens: { fills: "Bg" }, children: [] };
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [frame] }, label: "S" }], variables: vars });
  ok("[contrast] a single-mode system derives nothing, so it is never warned about", !has(res, "derived-mode-contrast"));
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
  const map = { components: { Button: { figma: { key: "ds-btn", name: "Button" } } } };
  const doc = { nodes: [{ type: "FRAME", id: "1:1", children: [instance("2:1", "other-a", "Widget"), instance("2:2", "other-a", "Widget")] }] };
  const cov = screenCoverage(map, DS_COMPONENTS, [doc]);
  ok("[screen-cov] a map covering the whole catalog can still cover 0% of the screen",
    cov.distinct === 1 && cov.inMap === 0 && cov.mapPct === 0);
  ok("[screen-cov] instances are counted separately from distinct components", cov.instances === 2);
  ok("[screen-cov] the unmapped list names the component and how often it appears",
    cov.unmapped.length === 1 && cov.unmapped[0].setName === "Widget" && cov.unmapped[0].instances === 2);
}
{
  const map = { components: { Button: { figma: { key: "ds-btn", name: "Button" } } } };
  const doc = { nodes: [{ type: "FRAME", id: "1:1", children: [instance("2:1", "ds-btn", "Button"), instance("2:2", "other", "Widget")] }] };
  const cov = screenCoverage(map, DS_COMPONENTS, [doc]);
  ok("[screen-cov] a real half-match reports 50%, in the map and in the catalog", cov.mapPct === 50 && cov.catalogPct === 50);
}

report();
