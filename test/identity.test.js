// Token and component IDENTITY, against livetest-3's real export (test/fixtures/livetest3/, built by
// its build.py from /Users/…/design-twin-livetest-3 — pruned to the Spacing/Border Radius collections
// and to the instance skeleton of three screens, every value copied, nothing hand-written).
//
// The defect (livetest-3 findings 21, 31, 35, 40, 44, 94, 95, 96, 106, 137, 183, 211, 226): the
// pipeline identified a Figma variable — and a component — by NAME, while the export is keyed on the
// Figma KEY. Names are not unique: that export holds two `Spacing / Space 4` (24 and 16) and two
// `Spacing / Space 2`, and its screens' component keys were all re-minted by a file duplication.
//
// Run with:  node test/identity.test.js
// P1_SRC=<dir holding design-to-code/ and bridge/> runs the same checks against another checkout
// (that is how the "fails before" half of each check was demonstrated).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ok, report } = require("./assert");

const SRC = process.env.P1_SRC || path.join(__dirname, "..");
const D2C = path.join(SRC, "design-to-code");
const FX = path.join(__dirname, "fixtures", "livetest3");
const read = (p) => JSON.parse(fs.readFileSync(path.join(FX, p), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dt-identity-"));
const node = (script, args, opts) => spawnSync(process.execPath, [path.join(D2C, script), ...args], Object.assign({ encoding: "utf8" }, opts || {}));
const tryRequire = (p) => { try { return require(p); } catch (e) { return null; } };

const POS = "pages/__Organization_management_/positions___7314_87192";
const GP = "pages/__Organization_management_/System_Configurations__1359_21337";
const CAT = "pages/In_progress/Create_Activity_Type__18411_84111";
const K24 = "e26d506ea43ae0582896add59d9e04156fb3f6d5", K16 = "64928e3a5f094c0d9a2c916f50b98ff37c789882";

// ------------------------------------------------------------------ tokens.js (44, 94, 95, 96, 137, 183)
console.log("tokens.js on the merged variables.json:");
{
  const out = tmp();
  const r = node("tokens.js", [path.join(FX, "variables.json"), out, "--web", "tailwind"]);
  const theme = fs.existsSync(path.join(out, "theme.css")) ? fs.readFileSync(path.join(out, "theme.css"), "utf8") : "";
  const css = fs.existsSync(path.join(out, "tokens.css")) ? fs.readFileSync(path.join(out, "tokens.css"), "utf8") : "";
  const dtcg = fs.existsSync(path.join(out, "tokens.dtcg.json")) ? JSON.parse(fs.readFileSync(path.join(out, "tokens.dtcg.json"), "utf8")) : {};
  const warnings = r.stderr || "";
  ok("[44] BOTH Space 4 variables reach theme.css — 24 and 16, each under its own name, neither silently dropped",
    /--spacing-figma-space-4-e26d506e: 24px;/.test(theme) && /--spacing-figma-space-4-64928e3a: 16px;/.test(theme));
  ok("[44] and no bare name is left to mean whichever came last", !/--spacing(-figma)?-space-4: /.test(theme));
  ok("[44] the warning names BOTH keys, BOTH values and the screen each came from — not 'later definition wins'",
    /e26d506e/.test(warnings) && /64928e3a/.test(warnings) && /"Mode 1":24/.test(warnings) && /"Desktop":16/.test(warnings)
      && /positions___7314_87192/.test(warnings) && /Create_Activity_Type__18411_84111/.test(warnings) && !/later definition wins/.test(warnings));
  ok("[44] tokens.css and tokens.dtcg.json keep both too, and the DTCG leaf carries its Figma key",
    /--Space-4-e26d506e: 24px;/.test(css) && /--Space-4-64928e3a: 16px;/.test(css)
      && !!dtcg["Space-4-e26d506e"] && dtcg["Space-4-e26d506e"].$extensions["figma.com"].key === K24);
  ok("[94] `Space 3` (16) and `(Space 3)` (12) are two reachable properties in theme.css, not one",
    /--spacing-figma-space-3: 16px;/.test(theme) && /--spacing-figma-space-3-a96c665b: 12px;/.test(theme));
  ok("[94] and the run WARNS about that pair (it used to fold them silently)", /'Space 3', '\(Space 3\)'/.test(warnings) && /a96c665b/.test(warnings));
  ok("[21/95] identical twins (the two `Space 2`, 8 everywhere) are emitted once and SAID to be two variables",
    (theme.match(/--spacing-figma-space-2(-[a-z0-9]+)?: /g) || []).length === 1 && /share the name 'Space 2'.*resolve identically/.test(warnings));

  // Order must not decide anything: the old emitters kept "the later one".
  const rev = clone(read("variables.json")); rev.variables.reverse();
  const revDir = tmp(); fs.writeFileSync(path.join(revDir, "v.json"), JSON.stringify(rev));
  node("tokens.js", [path.join(revDir, "v.json"), revDir, "--web", "tailwind"]);
  const decls = (t) => new Set((t.match(/^ {2}--[^\n]+$/gm) || []));
  const a = decls(theme), b = decls(fs.existsSync(path.join(revDir, "theme.css")) ? fs.readFileSync(path.join(revDir, "theme.css"), "utf8") : "");
  ok("[44] reversing the input rows changes no name→value pair in theme.css", a.size > 0 && a.size === b.size && [...a].every((x) => b.has(x)));
}
{
  const out = tmp();
  const r = node("tokens.js", [path.join(FX, POS + ".vars.json"), out, "--web", "tailwind"]);
  const theme = fs.existsSync(path.join(out, "theme.css")) ? fs.readFileSync(path.join(out, "theme.css"), "utf8") : "";
  ok("[95] a screen's OWN .vars.json (Job Roles: one Space 4) gets the plain name, at the value its Figma binds: 24",
    r.status === 0 && /--spacing-figma-space-4: 24px;/.test(theme));
  ok("[137] and even there `Space 3` keeps 16 — the screen's own slice no longer collapses it onto `(Space 3)`'s 12",
    /--spacing-figma-space-3: 16px;/.test(theme) && /--spacing-figma-space-3-a96c665b: 12px;/.test(theme));
}
{
  const out = tmp();
  const r = node("tokens.js", [path.join(FX, "design-system/tokens.json"), out, "--web", "tailwind"]);
  const theme = fs.existsSync(path.join(out, "theme.css")) ? fs.readFileSync(path.join(out, "theme.css"), "utf8") : "";
  const css = fs.existsSync(path.join(out, "tokens.css")) ? fs.readFileSync(path.join(out, "tokens.css"), "utf8") : "";
  ok("[183] no generated @theme variable redefines Tailwind's own scale: 0 lines of `--radius-xl:` (rounded-xl stays 12px)",
    r.status === 0 && (theme.match(/^ {2}--radius-xl:/gm) || []).length === 0 && !/^ {2}--radius-(l|s|m|full):/m.test(theme));
  ok("[183] Figma's XL radius is still there, under its own namespace", /--radius-figma-xl: 16px;/.test(theme));
  ok("[96] the 1e9 'fully rounded' sentinel never reaches CSS — 9999px instead", !/1000000000/.test(theme + css) && /--radius-figma-full: 9999px;/.test(theme) && /--Full: 9999px;/.test(css));
  const sw = tmp();
  node("tokens.js", [path.join(FX, "design-system/tokens.json"), sw, "--native", "swiftui"]);
  const swift = fs.existsSync(path.join(sw, "DesignTokens.swift")) ? fs.readFileSync(path.join(sw, "DesignTokens.swift"), "utf8") : "";
  ok("[96] …and SwiftUI gets `.infinity`, not 1000000000", /full: CGFloat = \.infinity/.test(swift) && !/1000000000/.test(swift));
}

// ------------------------------------------------------------------ design-diff.js (211)
console.log("design-diff.js — tokens are keyed by Figma key:");
{
  const dd = tryRequire(path.join(D2C, "design-diff.js"));
  const base = read("variables.json");
  const bump = (key, f) => { const d = clone(base); for (const v of d.variables) if (v.key === key) f(v); return d; };
  const d1 = dd && dd.diffTokens(base, bump(K24, (v) => { v.values = { "Mode 1": 25 }; }));
  ok("[211] changing ONLY the 24-valued Space 4 reports exactly one change, named with its key",
    !!d1 && d1.changed.length === 1 && /e26d506e/.test(d1.changed[0].name) && d1.changed[0].modes[0].before === "24" && d1.changed[0].modes[0].after === "25");
  const d2 = dd && dd.diffTokens(base, bump(K16, (v) => { v.values = Object.assign({}, v.values, { Desktop: 17 }); }));
  ok("[211] a change to the OTHER Space 4 is seen too (it used to be shadowed)",
    !!d2 && d2.changed.length === 1 && /64928e3a/.test(d2.changed[0].name) && d2.changed[0].modes[0].mode === "Desktop");
  const rev = clone(base); rev.variables.reverse();
  const d3 = dd && dd.diffTokens(base, rev);
  ok("[211] re-ordering the rows reports NOTHING (it used to report a false 24 → 16)", !!d3 && d3.summary.added + d3.summary.removed + d3.summary.changed === 0);
}

// ------------------------------------------------------------------ variables-merge.js (21)
console.log("variables-merge.js — same name, different key, is a conflict:");
{
  const vm = tryRequire(path.join(SRC, "bridge", "variables-merge.js"));
  const merged = read("variables.json");
  let doc = null;
  for (const s of merged._slices) doc = vm.mergeVariablesDoc(doc, read(s.file.replace(/\.json$/, ".vars.json")), { screen: s.screen, file: s.file, at: s.at }).doc;
  const space4 = (doc._conflicts || []).find((c) => c.name === "Space 4");
  ok("[21] replaying the five real pulls still ACCUMULATES (finding 20 must not regress)", doc.variables.length === merged.variables.length);
  ok("[21] `_conflicts` is no longer empty: the two `Space 4` are recorded, both keys, both values",
    !!space4 && space4.kind === "same-name" && space4.sameValue === false && space4.variants.map((v) => v.key).sort().join() === [K16, K24].sort().join());
  ok("[21] …with the screens each came from (64928e3a only from the two Create Activity Type pulls)",
    !!space4 && space4.variants.find((v) => v.key === K16).screens.join() === "Create_Activity_Type__18411_84111,Create_Activity_Type__18411_84502"
      && space4.variants.find((v) => v.key === K24).screens.includes("positions___7314_87192"));
  ok("[21] and mirrored into `hygiene`, the other place both skills say to read",
    doc.hygiene.some((h) => /CONFLICT/.test(h) && /'Space 4'/.test(h) && /e26d506e/.test(h) && /64928e3a/.test(h)));
  const space2 = (doc._conflicts || []).find((c) => c.name === "Space 2");
  ok("[21] the two `Space 2` (8 under Desktop/Tablet/Mobile, 8 under Mode 1) are recorded as the same VALUE", !!space2 && space2.sameValue === true);
}

// ------------------------------------------------------------------ cross-check.js (40, 106, 137, 226)
console.log("cross-check.js — attribution and the re-keyed catalog:");
const cc = (screenRel, extra) => {
  const r = node("cross-check.js", [path.join(FX, screenRel + ".json"), "--design-system", path.join(FX, "design-system"), "--variables", path.join(FX, "variables.json"), "--json", ...(extra || [])]);
  try { return JSON.parse(r.stdout); } catch (e) { return { findings: [], coverage: {}, componentProposals: [] }; }
};
const blockerOn = (res, code, token) => res.findings.some((f) => f.severity === "blocker" && f.code === code && (!token || f.token === token));
{
  const pos = cc(POS), cat = cc(CAT);
  ok("[40/106] Job Roles' own slice has ONE Space 4 (24, as the design system) — no token-name-collision blocker for it",
    Array.isArray(pos.findings) && pos.findings.length > 0 && !blockerOn(pos, "token-name-collision", "Space 4"));
  ok("[40] the union's ambiguity is still said, once, as a note naming the screen it belongs to",
    pos.findings.some((f) => f.code === "token-name-collision-elsewhere" && f.severity === "info" && /Create_Activity_Type__18411_84111/.test(f.message)));
  ok("[40] Create Activity Type's slice really carries both — there it IS a blocker, naming the 16-valued key",
    cat.findings.some((f) => f.severity === "blocker" && f.code === "token-name-collision" && f.token === "Space 4" && f.key === K16));
  ok("[137] Global Policies: no Space 4 blocker either", !blockerOn(cc(GP), "token-name-collision", "Space 4"));
}
{
  const ref = read("mapping.reference.json");
  for (const [k, screenRel, min] of [["job-roles", POS, 26], ["global-policies", GP, 23]]) {
    const res = cc(screenRel);
    const props = res.componentProposals || [];
    const refRows = ref[k].names;
    const refMatched = Object.entries(refRows).filter(([, r]) => r.match);
    const refResidual = Object.entries(refRows).filter(([, r]) => !r.match);
    ok(`[226] ${k}: reports the copy/re-key case as its own finding (catalog-rekeyed), not catalog-covers-nothing`,
      blockerOn(res, "catalog-rekeyed") && !res.findings.some((f) => f.code === "catalog-covers-nothing"));
    ok(`[226] ${k}: proposes ≥ 20 name+prop-signature matches (reference: ${min}) — ${props.length}`, props.length >= 20 && props.length === refMatched.length);
    ok(`[226] ${k}: name-for-name AND id-for-id the same as scripts-test/map-components.mjs`,
      refMatched.every(([n, r]) => props.some((p) => p.name === n && p.catalog.id === r.match)) && props.every((p) => refRows[p.name] && refRows[p.name].match === p.catalog.id));
    ok(`[226] ${k}: the same ${refResidual.length}-name residual, with the same first reason`,
      (res.componentResidual || []).length === refResidual.length &&
        refResidual.every(([n, r]) => (res.componentResidual || []).some((x) => x.name === n && x.reasons[0] === r.firstReason)));
    ok(`[226] ${k}: every proposal waits for a person — none is pre-confirmed`, props.length > 0 && props.every((p) => p.confirmed === false));
    ok(`[226] ${k}: counts are over VISIBLE instances (${ref[k].instances}), like the build`, res.coverage && res.coverage.instances === ref[k].instances);
  }
  // Tie-breaks the reference needed, checked individually.
  const byName = (res) => new Map((res.componentProposals || []).map((p) => [p.name, p]));
  const jr = byName(cc(POS));
  ok("[226] tie-breaks: filter button → 326:2869, Header → 842:3470, Component 1 → 842:4815",
    (jr.get("filter button") || {}).catalog?.id === "326:2869" && (jr.get("Header") || {}).catalog?.id === "842:3470" && (jr.get("Component 1") || {}).catalog?.id === "842:4815");
  ok("[226] duplicated definitions (Button 1:1056 / 191:2702) are a harmless tie, not a failure",
    (jr.get("Button") || {}).catalog?.id === "1:1056" && (jr.get("Button") || {}).tie === "duplicate-definitions");
}
{
  // A genuinely unrelated pair: same names, different prop signatures → still "wrong catalog".
  const dir = tmp(), ds = path.join(dir, "ds");
  fs.mkdirSync(ds);
  for (const f of ["tokens.json", "components.library.json"]) fs.copyFileSync(path.join(FX, "design-system", f), path.join(ds, f));
  const cat = read("design-system/components.local.json");
  for (const c of cat.components) {
    const p = {};
    for (const [k, v] of Object.entries(c.props || {})) p["Other " + k] = Object.assign({}, v, v.options ? { options: v.options.map((o) => o + " (other)") } : {});
    c.props = p;
    if (c.type === "COMPONENT") c.type = "COMPONENT_SET";
  }
  fs.writeFileSync(path.join(ds, "components.local.json"), JSON.stringify(cat));
  const r = node("cross-check.js", [path.join(FX, POS + ".json"), "--design-system", ds, "--json"]);
  let res = {}; try { res = JSON.parse(r.stdout); } catch (e) { /* stays empty */ }
  ok("[226] an unrelated catalog (same names, different prop signatures) still reports catalog-covers-nothing, with no proposals",
    Array.isArray(res.findings) && res.findings.some((f) => f.code === "catalog-covers-nothing") && !res.findings.some((f) => f.code === "catalog-rekeyed") && !(res.componentProposals || []).length);

  // And the ordinary case: keys NOT re-minted → resolved by key, no re-key finding at all.
  const same = read("design-system/components.local.json");
  const screen = read(POS + ".json");
  const keyOf = new Map();
  const walk = (n) => { if (n.type === "INSTANCE" && n.mainComponent) keyOf.set(n.mainComponent.setName || n.mainComponent.name, n.mainComponent.setKey || n.mainComponent.key); (n.children || []).forEach(walk); };
  screen.nodes.forEach(walk);
  for (const c of same.components) if (keyOf.has(c.name)) c.key = keyOf.get(c.name);
  fs.writeFileSync(path.join(ds, "components.local.json"), JSON.stringify(same));
  const r2 = node("cross-check.js", [path.join(FX, POS + ".json"), "--design-system", ds, "--json"]);
  let res2 = {}; try { res2 = JSON.parse(r2.stdout); } catch (e) { /* stays empty */ }
  ok("[226] control: when the keys DO match, it is key coverage, not a re-key proposal",
    Array.isArray(res2.findings) && !res2.findings.some((f) => f.code === "catalog-rekeyed" || f.code === "catalog-covers-nothing") && res2.coverage.matchedByLocalKey > 0);
}

// ------------------------------------------------------------------ map-bootstrap / drift-lint (226, 103)
console.log("map-bootstrap.js --from-proposals / drift-lint.js:");
{
  const dir = tmp();
  const report0 = path.join(dir, "pos.cross.json");
  fs.writeFileSync(report0, JSON.stringify(cc(POS)));
  const map = path.join(dir, "codeconnect.local.json");
  const none = node("map-bootstrap.js", [path.join(FX, "design-system/components.local.json"), "--out", map, "--from-proposals", report0]);
  ok("[226] nothing confirmed → nothing written, exit 1 (proposals are never accepted automatically)", none.status === 1 && !fs.existsSync(map));
  const rep = JSON.parse(fs.readFileSync(report0, "utf8"));
  const accept = new Set(["Button", "Header", "Pagination"]);
  for (const p of rep.componentProposals || []) if (accept.has(p.name)) p.confirmed = true;
  fs.writeFileSync(report0, JSON.stringify(rep));
  const yes = node("map-bootstrap.js", [path.join(FX, "design-system/components.local.json"), "--out", map, "--from-proposals", report0]);
  const m = fs.existsSync(map) ? JSON.parse(fs.readFileSync(map, "utf8")) : { components: {} };
  const btn = (rep.componentProposals || []).find((p) => p.name === "Button") || { instanceKeys: [] };
  ok("[226] stubs ONLY the 3 confirmed, filed under the screen's own instance key, pointing at the catalog key",
    yes.status === 0 && Object.keys(m.components).length === 3 && !!m.components[btn.instanceKeys[0]] && m.components[btn.instanceKeys[0]].figma.key === btn.catalog.key);
  ok("[226] the stub map is schema-valid", node("map-validate.js", [map]).status === 0);
  node("map-bootstrap.js", [path.join(FX, "design-system/components.local.json"), "--out", map]);
  const m2 = fs.existsSync(map) ? JSON.parse(fs.readFileSync(map, "utf8")) : { components: {} };
  ok("[226] a later plain map-bootstrap keeps the confirmed entry under the instance key (it would otherwise unmap the screen again)",
    !!m2.components[btn.instanceKeys[0]] && !m2.components[btn.catalog.key]);
  const dl = node("drift-lint.js", [map, path.join(FX, "design-system/components.local.json"), "--screen", path.join(FX, POS + ".json")]);
  ok("[226] drift-lint now resolves those instances through the map (screen coverage > 0)", /SCREEN COVERAGE: [1-9]\d*\//.test(dl.stderr));

  const fresh = path.join(dir, "fresh.json");
  node("map-bootstrap.js", [path.join(FX, "design-system/components.local.json"), "--out", fresh]);
  const dl0 = node("drift-lint.js", [fresh, path.join(FX, "design-system/components.local.json"), "--screen", path.join(FX, POS + ".json")]);
  ok("[226] with a catalog-only map, drift-lint names the re-key case instead of 'not the library this screen is built from'",
    dl0.status === 1 && /\[catalog-rekeyed\]/.test(dl0.stderr) && !/not the library this screen is built from/.test(dl0.stderr));
}

report();
