// plan-skeleton.js — generate design/plan/<screen>.json's skeleton FROM THE EXPORT, so the model fills
// in only what is genuinely a decision. P2b (livetest-3 §2.9 f; findings 79, 151, 155, 156, 196).
//
// Why: build-screen used to have the model hand-transcribe the whole plan — the token table, the
// component inventory, the anchors. That is how hidden nodes, mis-typed token names and wrong values
// entered the plan and then passed the Stop hook, because code and plan agreed with each other. Every
// fact below is DERIVED from the export; the model fills only `codeToken`, `mapModule`, `verdict`,
// `decision`, `route` and `deviations[]` (plus `files[]`, `architecture` and `verification` as it
// builds).
//
//   tokens[]      every variable the screen binds (node `tokens` maps, incl. fills/strokes/effects),
//                 one row per bound NAME, carrying the Figma KEY it resolves to in the screen's own
//                 .vars.json, its value in the mode this frame renders, the design-system definition
//                 (matched by key; by name only as a labelled fallback — a name match with a different
//                 value is exactly the `Space 4` 24-vs-16 trap), and how many VISIBLE / hidden nodes
//                 bind it. A token bound only by hidden layers is pre-marked `verdict:"hidden-only"`.
//   components[]  every VISIBLE instance (hidden layers are not built, so they are not planned), with
//                 key/setKey/name/variant/props and its identity: the design-system catalog entry it
//                 matches — by key, or by P1's name+prop-signature matcher (component-match.js) when a
//                 duplicated file re-keyed everything — and the codeconnect.local.json mapping when one
//                 exists. Component identity comes from here, never from a hand-placed attribute.
//   anchors{}     every VISIBLE node id → {name, type, parent, mapModule:""}. Fill `mapModule` on
//                 sections and instances; a node whose own mapModule is empty is covered by its nearest
//                 mapped ancestor, so a 12-row `.map()` or a reused shell needs one entry, not twelve.
//   hidden[]      the roots of every hidden subtree (`hidden: true`), with how many nodes each hides.
//
// Hidden predicate — the ONE rule, shared with verify-build.js: a node is hidden when it or any
// ancestor carries `"hidden": true`. Never `visible === false`: `"visible"` is also a component PROPERTY
// name in this export (`"visible": "Show Breadcrumb"`), finding 34.
//
// Output is deterministic (no timestamps of its own), so a re-run diffs cleanly. With --out on an
// existing plan it MERGES: every model-filled field (codeToken, mapModule, verdict, decision, …) and
// every top-level field the skeleton does not own (files, architecture, verification, deviations,
// status, …) is kept; rows that no longer exist in the export are dropped and counted on stderr.

const fs = require("fs");
const path = require("path");
const { matchByNameAndSignature, parseVariant } = require("./component-match");

const USAGE = [
  "usage: node plan-skeleton.js <screen.json> <screen.vars.json> <design-system dir> [--out <plan.json>] [--map <codeconnect.local.json>] [--route <route>]",
  "",
  "  Emits the build-screen plan skeleton for one screen, derived from the export:",
  "    tokens[]      every bound variable (keyed by Figma key, value in the frame's mode, design-system match)",
  "    components[]  every VISIBLE instance (key/setKey/name/props + catalog match / codeconnect mapping)",
  "    anchors{}     every VISIBLE node id, mapModule empty — fill it on sections and instances",
  "    hidden[]      roots of hidden subtrees (hidden: true or a hidden ancestor) — never built, never anchored",
  "    screenName / nodeId / file / route   the header every skill resolves a plan by",
  "",
  "  You fill in: codeToken, mapModule, verdict, decision, route, deviations[] (and files[], architecture,",
  "  verification as you build).",
  "",
  "  <design-system dir>  design/export/design-system (tokens.json, components.local.json). A missing",
  "                       directory is allowed (single-screen pull): values then come from the screen's",
  "                       own .vars.json and no catalog match is attempted — stderr says so.",
  "  --out <file>         write the plan there (default: stdout). An existing plan is MERGED, never",
  "                       overwritten: every field you filled is kept.",
  "  --map <file>         codeconnect.local.json (default: design/codeconnect.local.json or",
  "                       codeconnect.local.json in the current directory, when present).",
  "  --route <route>      the app route this screen will live at (else left null for you to fill).",
].join("\n");

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const readJsonOr = (f, fallback) => { try { return readJson(f); } catch { return fallback; } };

// The screen doc's roots, in any of the shapes the exporter writes (single-screen pull: `nodes[]`;
// page-walk layer file: `tree`; or a bare node).
function rootsOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.nodes)) return doc.nodes;
  if (doc.tree) return [doc.tree];
  if (doc.id || doc.type) return [doc];
  return [];
}

// Walk every node with its ancestry and hidden state. `hidden` = own `hidden: true` OR a hidden ancestor.
function walkNodes(doc, visit) {
  const go = (n, parent, hiddenAbove, insideInstance) => {
    if (!n || typeof n !== "object") return;
    const hidden = hiddenAbove || n.hidden === true;
    visit(n, { parent, hidden, hiddenRoot: n.hidden === true && !hiddenAbove, insideInstance });
    const inInst = n.type === "INSTANCE" ? n.id : insideInstance;
    for (const c of n.children || []) go(c, n, hidden, inInst);
  };
  for (const r of rootsOf(doc)) go(r, null, false, null);
}

// { visible: Map(id -> {node, parentId}), hidden: Set(id), hiddenRoots: [...] }
function visibility(doc) {
  const visible = new Map(), hidden = new Set(), hiddenRoots = [];
  const count = new Map();
  walkNodes(doc, (n, ctx) => {
    if (!n.id) return;
    if (ctx.hidden) {
      hidden.add(n.id);
      if (ctx.hiddenRoot) { hiddenRoots.push({ id: n.id, name: n.name, type: n.type, nodes: 0 }); count.set(n.id, hiddenRoots[hiddenRoots.length - 1]); }
    } else visible.set(n.id, { node: n, parentId: ctx.parent ? ctx.parent.id : null, insideInstance: ctx.insideInstance });
  });
  // how many nodes each hidden root hides (itself included)
  const tally = (n, root) => {
    if (!n || typeof n !== "object") return;
    const r = root || (count.has(n.id) ? n.id : null);
    if (r) count.get(r).nodes++;
    for (const c of n.children || []) tally(c, r);
  };
  for (const r of rootsOf(doc)) tally(r, null);
  return { visible, hidden, hiddenRoots };
}

// ---------------------------------------------------------------- tokens

// Every (name, field) a node binds: its own `tokens` map, and `tokens` maps nested in fills / strokes /
// effects / textRangeFills … (NOT in children — those are other nodes).
function bindingsOf(node) {
  const out = [];
  const collect = (o, where) => {
    if (Array.isArray(o)) { for (const x of o) collect(x, where); return; }
    if (!o || typeof o !== "object") return;
    if (o.tokens && typeof o.tokens === "object") {
      for (const [field, v] of Object.entries(o.tokens)) for (const name of [].concat(v)) if (typeof name === "string") out.push({ name, field: where ? `${where}.${field}` : field });
    }
    for (const [k, v] of Object.entries(o)) if (k !== "tokens" && k !== "children" && v && typeof v === "object") collect(v, where || k);
  };
  collect(Object.assign({}, node, { children: undefined }), "");
  return out;
}

function kindOf(variable, fields) {
  const t = variable && variable.type;
  if (t === "COLOR") return "color";
  if (t === "STRING") return /fontStyle|fontFamily|fontName/.test(fields.join(" ")) ? "fontStyle" : "string";
  if (t === "BOOLEAN") return "boolean";
  const f = fields.join(" ");
  if (/Radius/i.test(f)) return "radius";
  if (/fontSize/.test(f)) return "fontSize";
  if (/fontWeight/.test(f)) return "fontWeight";
  if (/lineHeight/.test(f)) return "lineHeight";
  if (/letterSpacing/.test(f)) return "letterSpacing";
  if (/padding|itemSpacing|counterAxisSpacing|gap/i.test(f)) return "spacing";
  if (/strokeWeight|strokeTopWeight|strokeWidth/i.test(f)) return "borderWidth";
  if (/width|height/i.test(f)) return "size";
  if (/opacity/i.test(f)) return "opacity";
  return "number";
}

const isAlias = (v) => v && typeof v === "object" && typeof v.aliasOf === "string";

// A variable's value in the mode this frame renders. The frame's `resolvedModes` names a mode per
// COLLECTION; an alias hops to another collection, whose own mode is looked up the same way.
function resolver(sources, resolvedModes) {
  const byName = new Map();
  const collections = new Map();
  for (const src of sources) {
    for (const v of (src && src.variables) || []) if (v && v.name && !byName.has(v.name)) byName.set(v.name, v);
    for (const c of (src && src.collections) || []) if (c && c.name && !collections.has(c.name)) collections.set(c.name, c);
  }
  const modeFor = (v) => {
    const vals = v.values || {};
    const keys = Object.keys(vals);
    const want = resolvedModes && resolvedModes[v.collection];
    if (want !== undefined && want in vals) return want;
    // case-only differences ("desktop" vs "Desktop") are the same mode
    if (want !== undefined) { const k = keys.find((x) => x.toLowerCase() === String(want).toLowerCase()); if (k) return k; }
    const c = collections.get(v.collection);
    if (c && c.default && c.default in vals) return c.default;
    return keys[0];
  };
  function resolve(v, depth) {
    if (!v || depth > 10) return { value: null, mode: null };
    const mode = modeFor(v);
    const raw = (v.values || {})[mode];
    if (isAlias(raw)) {
      const target = byName.get(raw.aliasOf);
      const r = resolve(target, depth + 1);
      return { value: r.value, mode, via: raw.aliasOf };
    }
    return { value: normValue(v.type, raw), mode };
  }
  return (v) => resolve(v, 0);
}

function normValue(type, raw) {
  if (raw === undefined || raw === null) return null;
  if (type === "COLOR" && typeof raw === "string") {
    const h = raw.trim().toLowerCase();
    return /^#[0-9a-f]{8}$/.test(h) && h.endsWith("ff") ? h.slice(0, 7) : h;
  }
  if (type === "COLOR" && typeof raw === "object" && "r" in raw) {
    const to = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
    const a = raw.a === undefined ? 1 : raw.a;
    return "#" + to(raw.r) + to(raw.g) + to(raw.b) + (a < 1 ? to(a) : "");
  }
  return raw;
}

function buildTokens(doc, vis, vars, ds, resolvedModes) {
  const uses = new Map(); // name -> { fields:Set, visible, hidden }
  walkNodes(doc, (n, ctx) => {
    for (const b of bindingsOf(n)) {
      if (!uses.has(b.name)) uses.set(b.name, { fields: new Set(), visible: 0, hidden: 0 });
      const u = uses.get(b.name);
      u.fields.add(b.field);
      if (ctx.hidden) u.hidden++; else u.visible++;
    }
  });
  const own = new Map();
  for (const v of (vars && vars.variables) || []) { if (!own.has(v.name)) own.set(v.name, []); own.get(v.name).push(v); }
  const dsByKey = new Map(), dsByName = new Map();
  for (const v of (ds && ds.variables) || []) {
    if (v.key) dsByKey.set(v.key, v);
    if (!dsByName.has(v.name)) dsByName.set(v.name, []);
    dsByName.get(v.name).push(v);
  }
  const ownResolve = resolver([vars, ds], resolvedModes);
  const dsResolve = resolver([ds], resolvedModes);

  const rows = [];
  for (const [name, u] of uses) {
    const fields = [...u.fields].sort();
    const cands = own.get(name) || [];
    const v = cands[0] || null;
    const r = v ? ownResolve(v) : { value: null, mode: null };
    const row = {
      figmaName: name,
      key: cands.length === 1 ? v.key || null : null,
      collection: v ? v.collection : null,
      kind: kindOf(v, fields),
      value: r.value,
      mode: r.mode,
      bindings: fields,
      sites: { visible: u.visible, hidden: u.hidden },
    };
    if (r.via) row.aliasOf = r.via;
    if (cands.length > 1) {
      // Two variables with ONE name in the screen's own slice: the node JSON binds by name only, so the
      // key cannot be derived. Say so rather than pick one.
      const vals = cands.map((c) => ({ key: c.key, collection: c.collection, value: ownResolve(c).value }));
      row.keyCandidates = vals;
      row.note = `${cands.length} variables in this screen's .vars.json are named '${name}'` +
        (new Set(vals.map((x) => JSON.stringify(x.value))).size > 1 ? " WITH DIFFERENT VALUES — decide which one the design means before mapping it" : " (same value) — either key describes it");
    }
    if (!v) row.note = `'${name}' is bound on the frame but not defined in the screen's .vars.json — re-pull the screen`;
    // Design-system definition: by KEY; a name-only match is a labelled fallback, never silently the value.
    let dv = null, how = null;
    for (const c of cands) if (c.key && dsByKey.has(c.key)) { dv = dsByKey.get(c.key); how = "key"; break; }
    if (!dv && dsByName.has(name)) {
      const same = dsByName.get(name).filter((x) => !v || x.collection === v.collection);
      dv = (same.length ? same : dsByName.get(name))[0];
      how = "name";
    }
    if (dv) {
      const dr = dsResolve(dv);
      row.designSystem = { match: how, key: dv.key || null, value: dr.value, agrees: JSON.stringify(dr.value) === JSON.stringify(r.value) };
    } else row.designSystem = null;
    row.codeToken = null;
    if (!u.visible) {
      row.verdict = "hidden-only";
      row.decision = "bound only by hidden layers — not built, so no code token is needed";
    } else row.verdict = null;
    rows.push(row);
  }
  rows.sort((a, b) => (b.sites.visible > 0) - (a.sites.visible > 0) || a.figmaName.localeCompare(b.figmaName));
  return rows;
}

// ---------------------------------------------------------------- components

function loadMap(file) {
  const map = readJsonOr(file, null);
  const keys = new Map();
  for (const [name, e] of Object.entries((map && map.components) || {})) {
    if (!e || !e.figma) continue;
    const entry = { name: e.figma.name || name, module: (e.code && e.code.module) || null, export: (e.code && e.code.export) || null, status: e.status || null };
    if (e.figma.key) keys.set(e.figma.key, entry);
    if (!keys.has(name)) keys.set(name, entry);
  }
  return keys;
}

function buildComponents(doc, catalog, library, mapKeys) {
  const insts = [];
  walkNodes(doc, (n, ctx) => {
    if (ctx.hidden || n.type !== "INSTANCE") return;
    const mc = n.mainComponent || {};
    insts.push({
      nodeId: n.id,
      layer: n.name,
      name: mc.setName || mc.name || n.name,
      key: mc.key || null,
      setKey: mc.setKey || null,
      remote: mc.remote === true,
      variant: parseVariant(n.component) || parseVariant(mc.variant),
      props: n.props && typeof n.props === "object" ? n.props : {},
      insideInstance: ctx.insideInstance || null,
    });
  });
  const catKeys = new Map();
  for (const c of (catalog && catalog.components) || []) if (c.key) catKeys.set(c.key, c);
  const byName = new Map();
  if (catalog) for (const r of matchByNameAndSignature(insts, catalog, library).rows) byName.set(r.name, r);

  return insts.map((i) => {
    let match = null;
    const k = [i.key, i.setKey].find((x) => x && catKeys.has(x));
    if (k) { const c = catKeys.get(k); match = { by: "key", id: c.id, key: c.key, name: c.name }; }
    else if (byName.has(i.name) && byName.get(i.name).match) {
      const r = byName.get(i.name);
      match = { by: r.evidence || "name+signature", id: r.match.id, key: r.match.key, name: r.match.name, confirmed: false };
    }
    const mapped = [i.key, i.setKey].map((x) => x && mapKeys.get(x)).find(Boolean) || null;
    const row = {
      nodeId: i.nodeId,
      name: i.name,
      layer: i.layer,
      key: i.key,
      setKey: i.setKey,
      variant: i.variant,
      props: i.props,
      catalog: match,
      mapped: mapped ? { module: mapped.module, export: mapped.export, status: mapped.status } : null,
      mapModule: mapped && mapped.module && !/^TODO/.test(mapped.module) ? mapped.module : "",
      verdict: null,
    };
    if (i.insideInstance) row.insideInstance = i.insideInstance;
    return row;
  });
}

// ---------------------------------------------------------------- the plan

function skeleton({ doc, vars, ds, catalog, library, mapKeys, screenFile, cwd, route, indexRow }) {
  const vis = visibility(doc);
  const roots = rootsOf(doc);
  const root = roots[0] || {};
  const resolvedModes = root.resolvedModes || {};
  const tokens = buildTokens(doc, vis, vars, ds, resolvedModes);
  const components = buildComponents(doc, catalog, library, mapKeys || new Map());
  const anchors = {};
  for (const [id, v] of vis.visible) anchors[id] = { name: v.node.name, type: v.node.type, parent: v.parentId, mapModule: "" };
  const nodeId = doc.nodeId || root.id || null;
  const title = indexRow && indexRow.title;
  const rel = screenFile ? path.relative(cwd || process.cwd(), path.resolve(screenFile)).split(path.sep).join("/") : null;
  return {
    schema: "designtwin/plan@2",
    screen: screenFile ? path.basename(screenFile).replace(/\.json$/, "") : null,
    screenName: String(title || doc.screen || root.name || "").trim() || null,
    nodeId,
    route: route || null,
    file: rel,
    exportedAt: doc.exportedAt || null,
    status: "pending",
    target: null,
    architecture: null,
    files: [],
    tokens,
    components,
    anchors,
    hidden: vis.hiddenRoots,
    deviations: [],
    counts: {
      tokens: tokens.length,
      tokensVisible: tokens.filter((t) => t.sites.visible > 0).length,
      instances: components.length,
      anchors: Object.keys(anchors).length,
      hiddenNodes: vis.hidden.size,
    },
  };
}

// Merge a fresh skeleton into an existing plan without losing anything a person or the model wrote.
const FILLED_TOKEN = ["codeToken", "verdict", "decision"];
const FILLED_COMPONENT = ["mapModule", "verdict", "decision", "matchedByName"];
function merge(fresh, prev) {
  if (!prev || typeof prev !== "object") return { plan: fresh, dropped: { tokens: 0, components: 0, anchors: 0 } };
  const out = Object.assign({}, prev, {
    schema: fresh.schema,
    screenName: prev.screenName || fresh.screenName,
    nodeId: fresh.nodeId,
    route: prev.route || fresh.route,
    file: fresh.file,
    exportedAt: fresh.exportedAt,
    hidden: fresh.hidden,
    counts: fresh.counts,
  });
  const dropped = { tokens: 0, components: 0, anchors: 0 };
  const tk = (t) => t.key || t.figmaName;
  const prevTok = new Map((Array.isArray(prev.tokens) ? prev.tokens : []).map((t) => [tk(t), t]));
  out.tokens = fresh.tokens.map((t) => {
    const p = prevTok.get(tk(t)) || prevTok.get(t.figmaName);
    const row = Object.assign({}, t);
    if (p) for (const f of FILLED_TOKEN) if (p[f] !== undefined && p[f] !== null && p[f] !== "") row[f] = p[f];
    return row;
  });
  dropped.tokens = [...prevTok.keys()].filter((k) => !fresh.tokens.some((t) => tk(t) === k || t.figmaName === k)).length;
  const prevComp = new Map((Array.isArray(prev.components) ? prev.components : []).filter((c) => c && c.nodeId).map((c) => [c.nodeId, c]));
  out.components = fresh.components.map((c) => {
    const p = prevComp.get(c.nodeId);
    const row = Object.assign({}, c);
    if (p) for (const f of FILLED_COMPONENT) if (p[f] !== undefined && p[f] !== null && p[f] !== "") row[f] = p[f];
    return row;
  });
  dropped.components = [...prevComp.keys()].filter((id) => !fresh.components.some((c) => c.nodeId === id)).length;
  const pa = prev.anchors && typeof prev.anchors === "object" ? prev.anchors : {};
  out.anchors = {};
  for (const [id, a] of Object.entries(fresh.anchors)) {
    const p = pa[id];
    out.anchors[id] = Object.assign({}, a, p && typeof p === "object" ? Object.fromEntries(Object.entries(p).filter(([k, v]) => !["name", "type", "parent"].includes(k) && v !== "" && v != null)) : {});
  }
  dropped.anchors = Object.keys(pa).filter((id) => !(id in fresh.anchors)).length;
  return { plan: out, dropped };
}

function findIndexRow(screenFile, nodeId) {
  // pages/<Page>/<Screen>__id.json → ../../pages/index.json or ../index.json
  const dir = path.dirname(path.resolve(screenFile));
  for (const idx of [path.join(dir, "..", "index.json"), path.join(dir, "index.json")]) {
    const d = readJsonOr(idx, null);
    const rows = d && Array.isArray(d.layers) ? d.layers : [];
    const hit = rows.find((r) => r.id === nodeId);
    if (hit) return hit;
  }
  return null;
}

function main(argv) {
  const args = argv.slice();
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); return 0; }
  const take = (flag) => { const i = args.indexOf(flag); if (i === -1) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const out = take("--out"), mapFlag = take("--map"), route = take("--route");
  const stray = args.filter((a) => a.startsWith("-"));
  if (stray.length || args.length !== 3 || [out, mapFlag, route].some((v) => v === "" )) {
    console.error((stray.length ? `plan-skeleton: unknown flag ${stray.join(", ")}\n` : "") + USAGE);
    return 2;
  }
  const [screenFile, varsFile, dsDir] = args;
  let doc, vars;
  try { doc = readJson(screenFile); } catch (e) { console.error(`plan-skeleton: cannot read the screen JSON ${screenFile}: ${e.message}`); return 1; }
  try { vars = readJson(varsFile); } catch (e) { console.error(`plan-skeleton: cannot read the screen's variables ${varsFile}: ${e.message}`); return 1; }
  const hasDs = dsDir && fs.existsSync(dsDir) && fs.statSync(dsDir).isDirectory();
  if (!hasDs) console.error(`plan-skeleton: no design-system directory at ${dsDir} — token values come from the screen's own .vars.json, and no catalog match was attempted (components[].catalog is null)`);
  const ds = hasDs ? readJsonOr(path.join(dsDir, "tokens.json"), null) : null;
  const catalog = hasDs ? readJsonOr(path.join(dsDir, "components.local.json"), null) : null;
  const library = hasDs ? readJsonOr(path.join(dsDir, "components.library.json"), null) : null;
  const mapFile = mapFlag || ["design/codeconnect.local.json", "codeconnect.local.json"].find((f) => fs.existsSync(f));
  const mapKeys = mapFile ? loadMap(mapFile) : new Map();
  const nodeId = doc.nodeId || (rootsOf(doc)[0] || {}).id;
  const fresh = skeleton({ doc, vars, ds, catalog, library, mapKeys, screenFile, cwd: process.cwd(), route, indexRow: findIndexRow(screenFile, nodeId) });
  const c = fresh.counts;
  if (!out) {
    process.stdout.write(JSON.stringify(fresh, null, 2) + "\n");
  } else {
    const prev = fs.existsSync(out) ? readJsonOr(out, undefined) : null;
    if (prev === undefined) { console.error(`plan-skeleton: ${out} exists but is not valid JSON — refusing to overwrite it`); return 1; }
    const { plan, dropped } = merge(fresh, prev);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
    console.error(`plan-skeleton: ${prev ? "merged into" : "wrote"} ${out}` + (prev ? ` (kept every filled field; dropped ${dropped.tokens} token row(s), ${dropped.components} component row(s), ${dropped.anchors} anchor(s) no longer in the export)` : ""));
  }
  console.error(`plan-skeleton: ${c.tokens} bound token(s) (${c.tokensVisible} on visible nodes), ${c.instances} visible instance(s), ${c.anchors} visible node anchor slot(s), ${c.hiddenNodes} hidden node(s) excluded`);
  return 0;
}

module.exports = { skeleton, merge, visibility, walkNodes, rootsOf, bindingsOf, buildTokens, buildComponents, USAGE };

// exitCode, not exit(): exit() would cut a large plan off mid-write when stdout is a pipe.
if (require.main === module) process.exitCode = main(process.argv.slice(2));
