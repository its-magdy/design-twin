// cross-check.js — does the screen you are about to build actually come from the design system you
// exported?
//
// Every other check in this repo reasons INSIDE one file. audit.js walks one screen's own JSON;
// drift-lint.js compares a map against the catalog it was bootstrapped from. Both can return a clean
// green while the screen and the design system are two unrelated Figma files — which is exactly what
// happened on the live run that produced this module:
//
//   * 0 of 65 instance keys on the screen matched any of the 318 components in the catalog, and
//     drift-lint still printed "318/318 components mapped · 0 error(s)" because its coverage metric
//     measures the catalog against itself and never against the screen.
//   * every collection key differed between the screen's variables and the design system's
//     (Semantic Variables 02 was ebac83f1… in one and 64113d4c… in the other) — the design file had
//     been DUPLICATED, which re-keys everything while leaving names and values identical.
//   * two names collided across the two libraries with DIFFERENT values: `(Space 3)` = 12 on the
//     screen vs `Space 3` = 16 in the design system; `light blue` = #1289db vs #94e2ff. A builder who
//     slugs the name and reaches for the existing token silently gets the wrong number.
//
// None of that is visible from either file alone. It is only visible from the JOIN, which is what
// this module is. It reports; it never rewrites anyone's data.
//
// Inputs are the shapes the plugin already writes, read as-is:
//   screens      [{ doc: design/<Screen>.json, label }]
//   variables    design/variables.json            — the tokens the SCREENS bind (their library)
//   tokens       design/design-system/tokens.json — the tokens the DESIGN SYSTEM defines
//   components   design/design-system/components.local.json   (+ .library.json, optional)
//   stylesText   design/design-system/styles.text.json        (optional)
// Every input is optional: with only screens it still reports the within-screen absurdities (a radius
// of a billion, font strays), and says plainly which cross-file checks it could not run.

const SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 };

// Figma's "fully rounded" idiom exports as a literal 1e9 (live finding 30). Anything at or past this
// is not a designed number, it is a sentinel, and it must never reach generated CSS as `1000000000px`.
const ABSURD_NUMBER = 10000;

// A component-key overlap at or below this is not "partial coverage", it is the wrong catalog.
const WRONG_CATALOG_PCT = 5;

function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

function rootsOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.nodes)) return doc.nodes;
  if (doc.tree) return [doc.tree];
  if (doc.id || doc.type) return [doc];
  return [];
}

// Names are compared case- and punctuation-insensitively ONLY to find near-misses worth reporting.
// Nothing is ever auto-bound on a normalised name — `Medium/14 Medium` vs `Medium/14 medium`
// (live finding 38) is precisely the near-miss a name-based mapper gets wrong silently, so it is
// surfaced as a question rather than resolved.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function crossCheck(input) {
  const screens = input.screens || [];
  const variables = input.variables || null;
  const tokens = input.tokens || null;
  const components = input.components || null;
  const componentsLibrary = input.componentsLibrary || null;
  const stylesText = input.stylesText || null;

  const findings = [];
  const notChecked = [];
  const push = (severity, code, message, extra) => findings.push(Object.assign({ severity, code, message }, extra || {}));

  // ---------------------------------------------------------------- what the screens actually use
  const usedTokenNames = new Map(); // name -> [{screen, nodeId, field}]
  const instances = []; // { screen, nodeId, name, key, setKey, setName, propNames }
  const fonts = new Map(); // family -> count
  const textStyles = new Map(); // style name -> count
  const resolvedModes = new Map(); // collection name -> Set(mode)

  for (const s of screens) {
    const label = s.label || (s.doc && s.doc.screen) || "screen";
    for (const root of rootsOf(s.doc)) {
      if (root && root.resolvedModes) {
        for (const [coll, mode] of Object.entries(root.resolvedModes)) {
          if (!resolvedModes.has(coll)) resolvedModes.set(coll, new Set());
          resolvedModes.get(coll).add(mode);
        }
      }
      walk(root, (n) => {
        for (const [field, name] of Object.entries(n.tokens || {})) {
          if (typeof name !== "string") continue;
          if (!usedTokenNames.has(name)) usedTokenNames.set(name, []);
          usedTokenNames.get(name).push({ screen: label, nodeId: n.id, field });
        }
        for (const f of n.fills || []) {
          const t = f && f.tokens && f.tokens.color;
          if (typeof t === "string") {
            if (!usedTokenNames.has(t)) usedTokenNames.set(t, []);
            usedTokenNames.get(t).push({ screen: label, nodeId: n.id, field: "fills" });
          }
        }
        if (n.type === "INSTANCE" && n.mainComponent) {
          const mc = n.mainComponent;
          instances.push({
            screen: label,
            nodeId: n.id,
            name: n.name,
            key: mc.key,
            setKey: mc.setKey,
            setName: mc.setName || mc.name,
            propNames: Object.keys(n.props || {}),
          });
        }
        if (n.font && n.font.family) fonts.set(n.font.family, (fonts.get(n.font.family) || 0) + 1);
        const ts = n.styles && n.styles.text;
        if (ts) textStyles.set(ts, (textStyles.get(ts) || 0) + 1);
      });
    }
  }

  // ---------------------------------------------------------------- (a) collections from elsewhere
  const dsCollByKey = new Map();
  const dsCollByName = new Map();
  for (const c of (tokens && tokens.collections) || []) {
    if (c.key) dsCollByKey.set(c.key, c);
    if (c.name) dsCollByName.set(norm(c.name), c);
  }
  const screenColls = (variables && variables.collections) || [];

  if (!tokens) {
    notChecked.push(
      "collection provenance — no design-system tokens.json was given, so nothing could verify that the screen's " +
        "variables come from the design system you exported. Run `dtwin pull design --design-system` and pass it."
    );
  } else if (!screenColls.length) {
    notChecked.push("collection provenance — no design/variables.json was given, so the screen's own token library is unknown.");
  } else {
    const foreign = [];
    for (const c of screenColls) {
      if (c.key && dsCollByKey.has(c.key)) continue;
      const twin = dsCollByName.get(norm(c.name));
      foreign.push({ name: c.name, key: c.key, twinKey: twin && twin.key, twinName: twin && twin.name });
    }
    if (foreign.length) {
      const sameNameDifferentKey = foreign.filter((f) => f.twinKey);
      const severity = foreign.length === screenColls.length ? "blocker" : "warning";
      push(
        severity,
        "foreign-token-library",
        `${foreign.length} of ${screenColls.length} variable collection(s) the screen binds are NOT in the design-system export — ` +
          `the screen consumes a DIFFERENT library than the one you pulled. ` +
          (sameNameDifferentKey.length
            ? `${sameNameDifferentKey.length} of them carry a design-system collection's name under a different key ` +
              `(${sameNameDifferentKey.slice(0, 3).map((f) => `'${f.name}'`).join(", ")}), which is the signature of a DUPLICATED Figma file: ` +
              `duplicating a library re-keys everything while leaving names and values identical. `
            : "") +
          `Names and values may still line up (check the collisions below), but nothing here is the same variable. ` +
          `To find the real owner: run \`dtwin list libraries --client <the screen's file>\` — variable collections are the ONE thing ` +
          `Figma attributes to a library by name — then open that file and export it with \`dtwin pull design --as-library "<name>"\`.`,
        { collections: foreign }
      );
    } else {
      push("info", "token-library-matches", `all ${screenColls.length} variable collection(s) the screen binds resolve to the design-system export by key.`, {});
    }
  }

  // ---------------------------------------------------------------- (c) name collisions and gaps
  const dsVarByName = new Map();
  for (const v of (tokens && tokens.variables) || []) if (v.name) dsVarByName.set(v.name, v);
  const screenVarByName = new Map();
  for (const v of (variables && variables.variables) || []) if (v.name) screenVarByName.set(v.name, v);

  // What a variable resolves to, flattened to a comparable scalar per mode. Aliases compare by their
  // TARGET name: two libraries that both alias `Primary/Primary` -> `Purple Shades/Purple 100` agree,
  // and that is the common, safe case (live finding 68) — it must not be reported as a conflict.
  function flatten(v) {
    const out = {};
    for (const [mode, val] of Object.entries((v && v.values) || {})) {
      out[mode] = val && typeof val === "object" ? (val.aliasOf != null ? "-> " + val.aliasOf : JSON.stringify(val)) : String(val);
    }
    return out;
  }
  // Mode NAMES are per-collection and two libraries rarely agree on them: the live case had the screen's
  // Spacing on Desktop/Tablet/Mobile and the design system's on a lone "Mode 1". With no shared mode an
  // early version returned "cannot say" and `(Space 3)`=12 vs `Space 3`=16 went unreported — the single
  // most dangerous collision in the whole run.
  //
  // Aligning on each collection's `default` mode does not work either, because the thing being detected
  // is name collision: that file has TWO collections called `Spacing`, so any map keyed on the collection
  // NAME picks the wrong default. So compare the SET of values instead. Sets that share nothing are a
  // real disagreement whatever the modes are called; sets that overlap at all are not provably wrong, and
  // this reports only what it can prove.
  function valueSet(v) {
    return new Set(Object.values(flatten(v)));
  }
  function sameResolution(a, b) {
    const fa = flatten(a), fb = flatten(b);
    const shared = Object.keys(fa).filter((m) => m in fb);
    if (shared.length) return shared.every((m) => fa[m] === fb[m]);
    const sa = valueSet(a), sb = valueSet(b);
    if (!sa.size || !sb.size) return null;
    for (const x of sa) if (sb.has(x)) return null; // some overlap — not provably a disagreement
    return false; // disjoint under every mode either side defines
  }

  if (tokens && screenVarByName.size) {
    const collisions = [], missing = [];
    for (const [name, sv] of screenVarByName) {
      const dv = dsVarByName.get(name);
      if (!dv) {
        // A near-miss on the name is worth more than a flat "missing": it is where a name-based
        // mapper silently binds to the wrong token.
        let near = null;
        for (const dname of dsVarByName.keys()) if (norm(dname) === norm(name) && dname !== name) { near = dname; break; }
        if (usedTokenNames.has(name) || near) missing.push({ name, near });
        continue;
      }
      const same = sameResolution(sv, dv);
      if (same === false) {
        collisions.push({ name, screen: flatten(sv), designSystem: flatten(dv), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
      }
    }
    // Names that differ only by punctuation/case ACROSS the two libraries, where the values differ —
    // `(Space 3)`=12 vs `Space 3`=16 is the live case, and it is worse than a missing token because a
    // slugger maps them onto the same CSS custom property.
    const dsByNorm = new Map();
    for (const [dname, dv] of dsVarByName) {
      const k = norm(dname);
      if (!dsByNorm.has(k)) dsByNorm.set(k, []);
      dsByNorm.get(k).push({ name: dname, v: dv });
    }
    for (const [name, sv] of screenVarByName) {
      if (dsVarByName.has(name)) continue;
      for (const cand of dsByNorm.get(norm(name)) || []) {
        if (sameResolution(sv, cand.v) === false) {
          collisions.push({ name, alsoKnownAs: cand.name, screen: flatten(sv), designSystem: flatten(cand.v), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
        }
      }
    }
    for (const c of collisions) {
      push(
        "blocker",
        "token-name-collision",
        `'${c.name}'${c.alsoKnownAs ? ` and the design system's '${c.alsoKnownAs}'` : ""} share a name but resolve DIFFERENTLY: ` +
          `screen ${JSON.stringify(c.screen)} vs design system ${JSON.stringify(c.designSystem)}` +
          (Object.keys(c.screen).some((m) => m in c.designSystem) ? ". " : " — no mode name is shared and the two value sets are disjoint. ") +
          `Slugging the name onto the existing token would silently apply the wrong value — namespace the screen's copy, or confirm which library is authoritative.`,
        { token: c.name, alsoKnownAs: c.alsoKnownAs, screenValue: c.screen, designSystemValue: c.designSystem, usedAt: c.usedAt }
      );
    }
    if (missing.length) {
      push(
        "warning",
        "token-absent-from-design-system",
        `${missing.length} token name(s) the screen binds do not exist in the design-system export` +
          (missing.some((m) => m.near)
            ? ` (${missing.filter((m) => m.near).length} differ from a design-system name only by case or punctuation — e.g. ` +
              missing.filter((m) => m.near).slice(0, 2).map((m) => `'${m.name}' vs '${m.near}'`).join(", ") + ")"
            : "") +
          `: ${missing.slice(0, 8).map((m) => "'" + m.name + "'").join(", ")}${missing.length > 8 ? ", …" : ""}. ` +
          `Build these as literals with a recorded decision — do not invent a design-system token for them.`,
        { tokens: missing }
      );
    }
  }

  // Bound names with no definition ANYWHERE (neither library) — the screen references a variable
  // neither export carries, which usually means an opt-in read was skipped or the slice is partial.
  if (variables) {
    const dangling = [];
    for (const name of usedTokenNames.keys()) {
      if (screenVarByName.has(name) || dsVarByName.has(name)) continue;
      dangling.push(name);
    }
    if (dangling.length) {
      push(
        "warning",
        "unresolvable-token",
        `${dangling.length} token name(s) are bound by a node but defined in NEITHER design/variables.json nor the design-system export: ` +
          `${dangling.slice(0, 8).map((n) => "'" + n + "'").join(", ")}${dangling.length > 8 ? ", …" : ""}. ` +
          `Re-pull the screen (variables.json now merges, so nothing is lost) or treat the node's raw value as authoritative.`,
        { tokens: dangling }
      );
    }
  }

  // ---------------------------------------------------------------- (b) catalog coverage
  const coverage = { instances: instances.length, distinct: 0, matchedByKey: 0, matchedByLocalKey: 0, matchedByName: 0, ambiguousName: 0, unmatched: 0, pct: null, localPct: null, entries: [] };
  // The LOCAL catalog is the one that matters: components.local.json is what map-bootstrap keys
  // codeconnect.local.json on and what build-screen resolves an instance against. components.library.json
  // is the design-system file's own list of components it CONSUMES from elsewhere, so a hit there means
  // "both files use the same third-party icon set", not "this screen is built from your design system".
  // Counted separately for exactly that reason — folding them together turned a 0% local match into a
  // reassuring-looking 13%.
  const localComps = (components && components.components) || [];
  const localKeys = new Set(localComps.map((c) => c.key).filter(Boolean));
  const catalog = [].concat(localComps, (componentsLibrary && componentsLibrary.components) || []);
  if (!catalog.length) {
    notChecked.push("component coverage — no components.local.json was given, so every instance counts as new by default.");
  } else if (!instances.length) {
    notChecked.push("component coverage — the screen export contains no INSTANCE nodes to compare.");
  } else {
    const byKey = new Map();
    const byName = new Map();
    for (const c of catalog) {
      if (c.key) byKey.set(c.key, c);
      const k = norm(c.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c);
    }
    // Distinct on the SET key where there is one: a screen using six Button variants is one component
    // to map, not six, and counting variants would flatter the coverage number.
    const distinct = new Map();
    for (const i of instances) {
      const id = i.setKey || i.key || "name:" + norm(i.setName);
      if (!distinct.has(id)) distinct.set(id, Object.assign({ count: 0 }, i));
      distinct.get(id).count++;
    }
    coverage.distinct = distinct.size;
    for (const [id, i] of distinct) {
      const byKeyHit = (i.setKey && byKey.get(i.setKey)) || (i.key && byKey.get(i.key));
      if (byKeyHit) {
        coverage.matchedByKey++;
        const local = localKeys.has(byKeyHit.key);
        if (local) coverage.matchedByLocalKey++;
        coverage.entries.push({ setName: i.setName, key: i.setKey || i.key, matchedBy: "key", scope: local ? "local" : "library", verified: true, catalogName: byKeyHit.name, instances: i.count });
        continue;
      }
      // Name+structure fallback. Never authoritative: a name match is a CANDIDATE, carried with
      // `verified: false` so build-screen can say "mapped by name, unverified" instead of either
      // pretending it is a real mapping or throwing away the only lead there is. Structure — how many
      // of the instance's prop names the candidate actually declares — is what separates a real
      // rename from two unrelated components both called `Header`.
      const cands = byName.get(norm(i.setName)) || [];
      let best = null;
      for (const c of cands) {
        const props = Object.keys(c.props || {}).map((p) => norm(String(p).split("#")[0]));
        const want = i.propNames.map((p) => norm(String(p).split("#")[0]));
        const hit = want.filter((p) => props.includes(p)).length;
        const score = want.length ? hit / want.length : props.length ? 0 : 0.5;
        if (!best || score > best.score) best = { c, score, hit, of: want.length };
      }
      // An AMBIGUOUS name is not a lead, it is a coin flip. The live file's own hygiene output flags
      // `Component 1`, `Header`, `Tabs` as duplicated/unnamed, and several catalog entries share each —
      // binding on that is the failure a name fallback exists to avoid, so it counts as unmatched and
      // is carried only as a suggestion.
      if (best && cands.length > 1) {
        coverage.ambiguousName++;
        coverage.unmatched++;
        coverage.entries.push({ setName: i.setName, key: i.setKey || i.key, matchedBy: null, ambiguous: true, candidates: cands.length, instances: i.count });
      } else if (best && (best.score >= 0.5 || cands.length === 1)) {
        coverage.matchedByName++;
        coverage.entries.push({
          setName: i.setName,
          key: i.setKey || i.key,
          matchedBy: "name",
          verified: false,
          catalogName: best.c.name,
          catalogKey: best.c.key,
          propOverlap: `${best.hit}/${best.of}`,
          instances: i.count,
        });
      } else {
        coverage.unmatched++;
        coverage.entries.push({ setName: i.setName, key: i.setKey || i.key, matchedBy: null, verified: false, instances: i.count });
      }
    }
    const matched = coverage.matchedByKey + coverage.matchedByName;
    coverage.pct = Math.round((coverage.matchedByKey / coverage.distinct) * 100);
    coverage.localPct = Math.round((coverage.matchedByLocalKey / coverage.distinct) * 100);
    const pctAny = Math.round((matched / coverage.distinct) * 100);

    if (coverage.localPct <= WRONG_CATALOG_PCT) {
      push(
        "blocker",
        "catalog-covers-nothing",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) used on this screen (${coverage.localPct}%) are in components.local.json by key — ` +
          `the catalog you exported is not the library this screen is built from. ` +
          (coverage.matchedByKey > coverage.matchedByLocalKey
            ? `${coverage.matchedByKey - coverage.matchedByLocalKey} more match components.library.json, which only means both files consume the same third-party set. `
            : "") +
          (coverage.matchedByName ? `${coverage.matchedByName} match BY NAME only and are marked unverified: a lead, not a mapping. ` : "") +
          (coverage.ambiguousName ? `${coverage.ambiguousName} more share a name with SEVERAL catalog entries ('Component 1'-class names) and are deliberately left unmatched. ` : "") +
          `A "318/318 mapped" count measures the catalog against itself and means nothing here. ` +
          `To find the owning library: open any instance in Figma and use right-click > "Go to main component" — it jumps to the file that ` +
          `defines it. Then connect that file and run \`dtwin pull design --as-library "<name>"\`. ` +
          `Until then every instance is correctly a \`verdict:"new"\` build, not a port of the catalog.`,
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, ambiguousName: coverage.ambiguousName, localPct: coverage.localPct } }
      );
    } else if (coverage.localPct < 100) {
      push(
        "warning",
        "partial-catalog-coverage",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) on this screen (${coverage.localPct}%) resolve to components.local.json by key` +
          (coverage.matchedByName ? `, ${coverage.matchedByName} more by name only (unverified)` : "") +
          `. The rest are new work: ${coverage.entries.filter((e) => !e.matchedBy).slice(0, 6).map((e) => "'" + e.setName + "'").join(", ")}.`,
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, localPct: coverage.localPct } }
      );
    } else {
      push("info", "catalog-covers-screen", `all ${coverage.distinct} component(s) on this screen resolve to components.local.json by key.`, {});
    }
    // ONE finding for the whole name-matched set. Emitting one per component produced 37 identical
    // paragraphs on the live run — a list nobody reads is the same as no list.
    const named = coverage.entries.filter((e) => e.matchedBy === "name");
    if (named.length) {
      push(
        "info",
        "name-matched-components",
        `${named.length} component(s) have no key in the catalog but DO have an exact name twin there: ` +
          named.slice(0, 10).map((e) => `'${e.setName}' (props ${e.propOverlap})`).join(", ") + (named.length > 10 ? `, …` : "") +
          `. Mapped BY NAME, UNVERIFIED — confirm one with "Go to main component" before reusing any of their code; ` +
          `if that one instance points at the catalog's file, the rest almost certainly do too.`,
        { components: named.map((e) => ({ setName: e.setName, catalogName: e.catalogName, catalogKey: e.catalogKey, propOverlap: e.propOverlap, verified: false })) }
      );
    }
    const amb = coverage.entries.filter((e) => e.ambiguous);
    if (amb.length) {
      push(
        "warning",
        "ambiguous-component-name",
        `${amb.length} component(s) share their name with SEVERAL catalog entries and were left unmatched on purpose: ` +
          amb.slice(0, 8).map((e) => `'${e.setName}' (${e.candidates} candidates)`).join(", ") + (amb.length > 8 ? ", …" : "") +
          `. Generic names like these are what the design system's own hygiene report flags as duplicated/unnamed — ` +
          `binding code to one of them by name would be a guess with a 1-in-${amb[0].candidates} chance.`,
        { components: amb.map((e) => ({ setName: e.setName, candidates: e.candidates })) }
      );
    }
  }

  // ---------------------------------------------------------------- font-family strays
  if (fonts.size > 1) {
    const sorted = [...fonts.entries()].sort((a, b) => b[1] - a[1]);
    const [mainFamily, mainCount] = sorted[0];
    const strays = sorted.slice(1);
    const total = sorted.reduce((n, [, c]) => n + c, 0);
    push(
      "warning",
      "font-family-stray",
      `${total} text node(s) use ${sorted.length} different font families: ${sorted.map(([f, c]) => `${f} (${c})`).join(", ")}. ` +
        `'${mainFamily}' carries ${mainCount}; the rest are strays — usually a starter-kit style (Figma's Material 3 kit leaks \`material-theme/*\`) ` +
        `left on a layer. Ask the designer before shipping a second webfont for ${strays.reduce((n, [, c]) => n + c, 0)} node(s).`,
      { families: sorted.map(([family, count]) => ({ family, count })) }
    );
  }
  if (stylesText && stylesText.styles && fonts.size) {
    const dsFamilies = new Set((stylesText.styles || []).map((s) => s.font).filter(Boolean));
    const foreign = [...fonts.keys()].filter((f) => dsFamilies.size && !dsFamilies.has(f));
    if (foreign.length) {
      push(
        "warning",
        "font-not-in-design-system",
        `font ${foreign.map((f) => `'${f}'`).join(", ")} appears on the screen but NO design-system text style uses it ` +
          `(the design system's text styles are all ${[...dsFamilies].join(", ")}). ` +
          `Nothing in the export declares a font file or a webfont for either, so "is it installed and licensed" is a question only the designer can answer.`,
        { fonts: foreign, designSystemFonts: [...dsFamilies] }
      );
    }
  }

  // ---------------------------------------------------------------- text-style strays / near-misses
  if (stylesText && stylesText.styles && textStyles.size) {
    const dsByName = new Map((stylesText.styles || []).map((s) => [s.name, s]));
    const dsNorm = new Map();
    for (const s of stylesText.styles || []) dsNorm.set(norm(s.name), s.name);
    const absent = [], nearMiss = [];
    for (const name of textStyles.keys()) {
      if (dsByName.has(name)) continue;
      const near = dsNorm.get(norm(name));
      if (near) nearMiss.push({ name, near });
      else absent.push(name);
    }
    if (nearMiss.length) {
      push(
        "blocker",
        "text-style-near-miss",
        `${nearMiss.length} text style name(s) differ from a design-system style ONLY by case or punctuation: ` +
          nearMiss.map((n) => `'${n.name}' vs '${n.near}'`).join(", ") +
          `. That is the exact near-miss a name-based mapping binds wrongly and silently. Confirm they are the same style before reusing it.`,
        { styles: nearMiss }
      );
    }
    if (absent.length) {
      push(
        "warning",
        "text-style-absent",
        `${absent.length} of ${textStyles.size} text style(s) used on the screen are not in the design-system export: ` +
          absent.slice(0, 8).map((n) => "'" + n + "'").join(", ") + (absent.length > 8 ? ", …" : "") + ".",
        { styles: absent }
      );
    }
  }

  // ---------------------------------------------------------------- absurd token values
  const absurd = [];
  const seenAbsurd = new Set(); // the same variable appears in both the design system and the screen slice
  for (const v of [].concat((tokens && tokens.variables) || [], (variables && variables.variables) || [])) {
    for (const [mode, val] of Object.entries((v && v.values) || {})) {
      const n = typeof val === "number" ? val : val && typeof val === "object" && typeof val.value === "number" ? val.value : null;
      if (n == null || Math.abs(n) < ABSURD_NUMBER) continue;
      const id = `${v.collection}/${v.name}/${mode}`;
      if (seenAbsurd.has(id)) continue;
      seenAbsurd.add(id);
      absurd.push({ name: v.name, collection: v.collection, mode, value: n });
    }
  }
  if (absurd.length) {
    push(
      "warning",
      "sentinel-token-value",
      `${absurd.length} token value(s) are sentinels, not measurements: ` +
        absurd.slice(0, 4).map((a) => `'${a.name}' = ${a.value} (${a.mode})`).join(", ") + (absurd.length > 4 ? ", …" : "") +
        `. Figma's "fully rounded" corner exports as a literal 1e9. Emit these as the platform's own idiom ` +
        `(CSS 9999px or 50%, SwiftUI .infinity, Compose CircleShape) — never as \`${absurd[0].value}px\`.`,
      { tokens: absurd }
    );
  }

  // ---------------------------------------------------------------- single-mode export
  // Deduped by collection NAME: the same collection is present in both the design system's tokens and
  // the screen's slice, and reporting it twice was just noise.
  const multiModeColls = [];
  const seenColl = new Set();
  for (const c of [].concat((tokens && tokens.collections) || [], screenColls)) {
    if (!Array.isArray(c.modes) || c.modes.length <= 1) continue;
    if (seenColl.has(c.name)) continue;
    seenColl.add(c.name);
    multiModeColls.push(c);
  }
  for (const c of multiModeColls) {
    const seen = resolvedModes.get(c.name);
    if (!seen || !seen.size) continue;
    if (seen.size === 1 && c.modes.length > 1) {
      const only = [...seen][0];
      const rest = c.modes.filter((m) => m !== only);
      push(
        "warning",
        "single-mode-export",
        `every exported frame resolved collection '${c.name}' in mode '${only}', but it defines ${c.modes.length} modes (${c.modes.join(", ")}). ` +
          `The other ${rest.length} mode(s) are DERIVED from variable values, never seen rendered — so any element whose ${only}-mode token has no ` +
          `sensible counterpart (a dark surface token that stays dark in Light) will be mechanically correct and visually broken. ` +
          `Export a frame in ${rest.map((m) => `'${m}'`).join(" / ")} too, or have the designer confirm the derivation before it ships.`,
        { collection: c.name, exportedMode: only, modes: c.modes }
      );
    }
  }

  // ---------------------------------------------------------------- contrast in the modes nobody drew
  //
  // When only the Dark frame was exported, every other mode is DERIVED from variable values and has
  // never been seen rendered. On the live run that derivation was mechanically correct and visually
  // broken in exactly one place: `Backgrounds/Side menu` resolves to `Indigo 400` in Light — still a
  // dark surface — while the sidebar's own label token flips to a dark gray, so the Light sidebar's
  // navigation labels were near-invisible. The audit asked the right question; nothing answered it.
  //
  // Everything needed to answer it is already on disk: each text node carries the token its colour is
  // bound to, its ancestors carry the token their background is bound to, and the variable file gives
  // both tokens' value in EVERY mode. So resolve the pair per mode and do the contrast arithmetic.
  contrastPerMode(screens, variables, tokens, push, resolvedModes);

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
    coverage,
    findings,
    notChecked,
    inputs: {
      screens: screens.map((s) => s.label),
      variables: !!variables,
      tokens: !!tokens,
      components: !!components,
      stylesText: !!stylesText,
    },
  };
}


// ---------------------------------------------------------------- contrast arithmetic (WCAG 2.2)
// Deliberately a local copy of the two formulas rather than a require of audit.js: this module is
// bundled standalone into claude-plugin/scripts/, and audit.js requires THIS file — importing back
// would be a cycle. They are eight lines and the spec has not changed since 2008.
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}
function relLuminance(c) {
  const ch = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function ratio(a, b) {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG AA for body text. Large text is 3:1, but the export does not reliably say which is which and
// over-reporting a heading is far cheaper than missing an unreadable nav label.
const MIN_CONTRAST = 4.5;

function contrastPerMode(screens, variables, tokens, push, resolvedModes) {
  const defs = new Map(); // token name -> variable record (the screen's own library wins: it is what the screen binds)
  for (const v of (tokens && tokens.variables) || []) if (v.name) defs.set(v.name, v);
  for (const v of (variables && variables.variables) || []) if (v.name) defs.set(v.name, v);
  if (!defs.size) return;

  // A token's hex in one mode, following aliases. Depth-limited rather than cycle-tracked: a Figma
  // alias chain is two or three links in practice, and a malformed file must not hang the check.
  function resolve(name, mode, depth) {
    if (depth > 8) return null;
    const v = defs.get(name);
    if (!v || !v.values) return null;
    let val = v.values[mode];
    if (val === undefined) {
      const keys = Object.keys(v.values);
      if (keys.length !== 1) return null; // several modes and none of them is this one — do not guess
      val = v.values[keys[0]];
    }
    if (typeof val === "string") return hexToRgb(val);
    if (val && typeof val === "object" && val.aliasOf) return resolve(val.aliasOf, mode, depth + 1);
    return null;
  }

  // Which modes to check: every mode of every collection that actually defines one of the tokens in
  // play. Names are per-collection, so this is a union of names, not a cross-product.
  const modes = new Set();
  for (const c of [].concat((tokens && tokens.collections) || [], (variables && variables.collections) || [])) {
    for (const m of (c && c.modes) || []) modes.add(m);
  }
  // Skip the modes the export was actually RENDERED in. Those already have a contrast check that is
  // strictly better — audit.js walks the real composited backgrounds, where this one can only see the
  // nearest token-bound ancestor and will call a header sitting on an absolutely-positioned child
  // white-on-white. This check exists for the modes NOBODY HAS SEEN, and saying so is most of its value.
  const rendered = new Set();
  for (const set of (resolvedModes || new Map()).values()) for (const m of set) rendered.add(m);
  for (const m of rendered) modes.delete(m);
  if (!modes.size) return; // every mode of this system was exported — nothing is being derived
  if (!rendered.size) return; // nothing was resolved at all: no basis for calling any mode "derived"

  const pairs = new Map(); // "fg|bg" -> { fg, bg, nodes:[], sample }
  for (const s of screens) {
    for (const root of rootsOf(s.doc)) {
      walkWithBg(root, null, (n, bgToken) => {
        if (n.type !== "TEXT" || !bgToken) return;
        const fg = (n.tokens && (n.tokens.fills || n.tokens.textRangeFills)) ||
          ((n.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean));
        if (!fg || typeof fg !== "string") return;
        const key = fg + "|" + bgToken;
        if (!pairs.has(key)) pairs.set(key, { fg, bg: bgToken, nodes: [], sample: n.name });
        if (pairs.get(key).nodes.length < 4) pairs.get(key).nodes.push(n.id);
      });
    }
  }
  if (!pairs.size) return;

  const failures = [];
  for (const p of pairs.values()) {
    for (const mode of modes) {
      const fg = resolve(p.fg, mode, 0);
      const bg = resolve(p.bg, mode, 0);
      if (!fg || !bg) continue; // this pair is not defined in this mode — say nothing rather than guess
      const r = ratio(fg, bg);
      if (r >= MIN_CONTRAST) continue;
      failures.push({ mode, fg: p.fg, bg: p.bg, ratio: Number(r.toFixed(2)), nodes: p.nodes, sample: p.sample });
    }
  }
  if (!failures.length) return;

  // Grouped by mode, because the actionable unit is "Light is broken", not thirty separate rows.
  const byMode = new Map();
  for (const f of failures) {
    if (!byMode.has(f.mode)) byMode.set(f.mode, []);
    byMode.get(f.mode).push(f);
  }
  for (const [mode, list] of byMode) {
    push(
      "blocker",
      "derived-mode-contrast",
      `in mode '${mode}', ${list.length} text/background token pair(s) fall below WCAG AA (${MIN_CONTRAST}:1): ` +
        list.slice(0, 4).map((f) => `'${f.fg}' on '${f.bg}' = ${f.ratio}:1 (e.g. ${f.sample})`).join("; ") +
        (list.length > 4 ? ", …" : "") +
        `. No frame was exported in '${mode}', so this mode is DERIVED from variable values and nobody has ever seen it rendered — ` +
        `the derivation is mechanically correct and visually broken. Export a '${mode}' frame, or get the designer to say ` +
        `which token each of these should use there. Do not invent an override and call it done.`,
      { mode, pairs: list }
    );
  }
}

// Walk carrying the nearest ancestor background TOKEN down the tree — a text node's contrast is
// against whatever surface it sits on, which is virtually never its own parent's own fill.
function walkWithBg(node, bgToken, fn) {
  if (!node || typeof node !== "object") return;
  if (node.visible === false) return;
  let bg = bgToken;
  const own = (node.tokens && node.tokens.fills) ||
    ((node.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean));
  if (own && typeof own === "string" && node.type !== "TEXT") bg = own;
  fn(node, bg);
  for (const c of node.children || []) walkWithBg(c, bg, fn);
}

function toMarkdown(res) {
  const L = [];
  L.push(`# Cross-file check — ${res.inputs.screens.join(", ") || "(no screens)"}`, "");
  L.push(
    `**${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info. ` +
      `Every check here is a JOIN between the screen and the design system — none of it is visible from either file alone.`,
    ""
  );
  const c = res.coverage;
  if (c && c.distinct) {
    L.push("## Component coverage of THIS screen", "");
    L.push(`| | count |`, `|---|---|`);
    L.push(`| instances on the screen | ${c.instances} |`);
    L.push(`| distinct components | ${c.distinct} |`);
    L.push(`| in **components.local.json** by key (verified) | ${c.matchedByLocalKey} (${c.localPct}%) |`);
    L.push(`| in components.library.json by key (a shared third-party set) | ${c.matchedByKey - c.matchedByLocalKey} |`);
    L.push(`| by name only (**unverified**) | ${c.matchedByName} |`);
    L.push(`| name shared with several catalog entries — left unmatched | ${c.ambiguousName} |`);
    L.push(`| no match at all — new work | ${c.unmatched} |`, "");
  }
  for (const sev of ["blocker", "warning", "info"]) {
    const fs = res.findings.filter((f) => f.severity === sev);
    if (!fs.length) continue;
    L.push(`## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs.length})`, "");
    for (const f of fs) L.push(`- \`${f.code}\` ${f.message}`);
    L.push("");
  }
  if (res.notChecked.length) {
    L.push("## Not checked", "", "*These are gaps in the INPUT, not clean results:*", "");
    for (const n of res.notChecked) L.push(`- ${n}`);
    L.push("");
  }
  return L.join("\n") + "\n";
}

module.exports = { crossCheck, toMarkdown, ABSURD_NUMBER, WRONG_CATALOG_PCT };

// CLI: node design-to-code/cross-check.js <screen.json>... [--design-system design/design-system]
//        [--variables design/variables.json] [--out design/audit/<screen>.cross] [--json] [--gate]
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const { readJsonFile } = require("./catalog-input.js");
  const argv = process.argv.slice(2);
  const take = (flag) => { const i = argv.indexOf(flag); if (i === -1) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const strip = (flag) => { const i = argv.indexOf(flag); if (i === -1) return false; argv.splice(i, 1); return true; };
  const dsDir = take("--design-system");
  const varsFile = take("--variables");
  const out = take("--out");
  const jsonOnly = strip("--json"), gate = strip("--gate");
  const USAGE =
    "usage: node design-to-code/cross-check.js <screen.json>... [--design-system design/design-system] " +
    "[--variables design/variables.json] [--out design/audit/<screen>.cross] [--json] [--gate]";
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
  const stray = argv.filter((a) => a.startsWith("-"));
  if (stray.length || !argv.length) { console.error((stray.length ? `cross-check: unknown flag ${stray.join(", ")}\n` : "") + USAGE); process.exit(2); }

  // Optional inputs are read only when present: the whole point is that this runs on a project that
  // has a screen and nothing else, and SAYS which checks it could not do (notChecked) rather than
  // dying on a missing design system.
  const maybe = (f) => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
  const screens = argv.map((f) => ({ doc: readJsonFile(f, "screen export"), label: path.basename(f, ".json") }));
  const dsBase = dsDir || "design/design-system";
  const res = crossCheck({
    screens,
    variables: maybe(varsFile || path.join(path.dirname(argv[0]), "variables.json")),
    tokens: maybe(path.join(dsBase, "tokens.json")),
    components: maybe(path.join(dsBase, "components.local.json")),
    componentsLibrary: maybe(path.join(dsBase, "components.library.json")),
    stylesText: maybe(path.join(dsBase, "styles.text.json")),
  });
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out + ".json", JSON.stringify(res, null, 2) + "\n");
    fs.writeFileSync(out + ".md", toMarkdown(res));
    console.error(`wrote ${out}.json and ${out}.md`);
  } else {
    process.stdout.write(toMarkdown(res));
  }
  console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  for (const n of res.notChecked) console.error(`note  not checked: ${n}`);
  process.exit(gate && res.summary.blockers > 0 ? 1 : 0);
}
