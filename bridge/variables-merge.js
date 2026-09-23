// variables-merge.js — design/variables.json accumulates across single-screen pulls.
//
// A `--node`/`--selection` pull returns only the variables THAT node binds. Writing that slice
// straight to design/variables.json (what this module replaced) meant every pull silently deleted
// the previous screen's tokens: pull screen A, pull screen B, and A's theme no longer resolves.
// Nothing warned, because the screen JSON carries raw hex beside every binding — so the build still
// renders, just unthemed. That is the worst shape a data-loss bug can take.
//
// So: merge. A variable's identity is its Figma `key` (stable across files and across pulls); only
// when a key is absent (never seen on a real export, but the field is optional in the IR) do we fall
// back to collection+name, which is the weakest thing that is still not wrong. Collections merge the
// same way, unioning their `modes` — two slices of one collection can legitimately report different
// mode subsets.
//
// Merge direction: the NEW slice wins a value conflict (it is the fresher read of the same file) and
// the disagreement is recorded in `_conflicts` + `hygiene` rather than silently resolved. On the live
// runs that produced this module there were zero conflicts across five slices, which is the expected
// case: the slices are views of one variable set.
//
// Provenance is kept, not inferred: `_slices` records one entry per contributing pull — including the
// KEYS that pull carried — and the raw slice is also written verbatim beside its screen as
// <Screen>.vars.json by write-out.js. So "which screen did this variable come from" survives the
// merge, and deleting design/export/variables.json resets everything.
//
// Two DIFFERENT variables (distinct keys) with the SAME collection and name are both kept — the key
// is the identity — but they are a conflict for every consumer that looks a token up by name, which
// is most of them (a theme generator, a slugged CSS variable, a designer reading a list). livetest-3
// (finding 21) had two `Spacing / Space 4` (24 and 16) and two `Spacing / Space 2` in the union and
// an EMPTY `_conflicts`, because only same-key value changes were ever recorded. Each such pair is
// now a `_conflicts` entry of kind "same-name", naming every key, its values and the screens whose
// slice carries it, and a CONFLICT line in `hygiene` — the two places the skills tell a reader to look.

// Finding 323: this used to say the per-pull slices are kept "under variables/" — a directory that
// has never existed. bridge/pages-layout.js's own screenPaths() writes each slice BESIDE its screen,
// as pages/<Page>/<Screen>__<id>.vars.json (see design/README.md's template), not into a
// top-level variables/ directory. Point at the real thing instead of a plausible-sounding guess.
const MERGE_NOTE =
  "Merged across single-screen pulls: this file is the UNION of every --node/--selection export " +
  "written into this directory, keyed on each variable's Figma key. Per-pull slices are kept verbatim " +
  "beside each screen, as pages/<Page>/<Screen>__<id>.vars.json. Delete this file to start over.";

function varId(v) {
  if (v && typeof v.key === "string" && v.key) return "k:" + v.key;
  return "n:" + String((v && v.collection) || "") + "\u0000" + String((v && v.name) || "");
}

function collId(c) {
  if (c && typeof c.key === "string" && c.key) return "k:" + c.key;
  return "n:" + String((c && c.name) || "");
}

// Value equality is compared on the fields that DECIDE a token: what it resolves to per mode, and
// what kind of thing it is. Metadata that legitimately differs between slices (scopes reported by a
// partial read, hiddenFromPublishing) is not a conflict, so it does not generate noise.
function sameValue(a, b) {
  return JSON.stringify(a && a.values) === JSON.stringify(b && b.values) && (a && a.type) === (b && b.type);
}

function mergeModes(prev, next) {
  const out = Array.isArray(prev) ? prev.slice() : [];
  for (const m of Array.isArray(next) ? next : []) if (!out.includes(m)) out.push(m);
  return out;
}

// prev/next are whole variables.json documents ({collections, variables, hygiene}). `slice` names the
// pull that produced `next` so the provenance list can carry it. Returns the merged doc plus the
// stats the CLI prints — callers decide how loud to be, this module never logs.
function mergeVariablesDoc(prev, next, slice) {
  const nextDoc = next || {};
  if (!prev || typeof prev !== "object" || (!Array.isArray(prev.variables) && !Array.isArray(prev.collections))) {
    // First pull into this directory: nothing to merge, but stamp the provenance so the second pull
    // has a list to append to rather than an unexplained new key.
    const doc = {
      collections: Array.isArray(nextDoc.collections) ? nextDoc.collections.slice() : [],
      variables: Array.isArray(nextDoc.variables) ? nextDoc.variables.slice() : [],
      hygiene: Array.isArray(nextDoc.hygiene) ? nextDoc.hygiene.slice() : [],
    };
    doc._slices = slice ? [sliceEntry(slice, doc)] : [];
    const nameConflicts = sameNameConflicts(doc.variables, doc._slices);
    applyNameConflicts(doc, nameConflicts, []);
    doc._note = MERGE_NOTE;
    doc.exportedAt = docExportedAt(doc._slices);
    return {
      doc,
      stats: { added: doc.variables.length, updated: 0, kept: 0, conflicts: [], nameConflicts, collections: doc.collections.length, first: true },
    };
  }

  const collections = [];
  const collIndex = new Map();
  for (const c of Array.isArray(prev.collections) ? prev.collections : []) {
    const id = collId(c);
    if (collIndex.has(id)) continue;
    collIndex.set(id, collections.length);
    collections.push(Object.assign({}, c));
  }
  for (const c of Array.isArray(nextDoc.collections) ? nextDoc.collections : []) {
    const id = collId(c);
    if (!collIndex.has(id)) {
      collIndex.set(id, collections.length);
      collections.push(Object.assign({}, c));
      continue;
    }
    const at = collIndex.get(id);
    const merged = Object.assign({}, collections[at], c);
    merged.modes = mergeModes(collections[at].modes, c.modes);
    collections[at] = merged;
  }

  const variables = [];
  const varIndex = new Map();
  for (const v of Array.isArray(prev.variables) ? prev.variables : []) {
    const id = varId(v);
    if (varIndex.has(id)) continue;
    varIndex.set(id, variables.length);
    variables.push(v);
  }
  const stats = { added: 0, updated: 0, kept: 0, conflicts: [], collections: collections.length, first: false };
  for (const v of Array.isArray(nextDoc.variables) ? nextDoc.variables : []) {
    const id = varId(v);
    if (!varIndex.has(id)) {
      varIndex.set(id, variables.length);
      variables.push(v);
      stats.added++;
      continue;
    }
    const at = varIndex.get(id);
    const before = variables[at];
    if (sameValue(before, v)) {
      // Same token, same resolution — keep the richer record rather than the newer one, so a slice
      // that happened to read fewer scopes cannot strip fields an earlier slice captured.
      variables[at] = Object.assign({}, v, before);
      stats.kept++;
      continue;
    }
    stats.conflicts.push({
      name: v.name,
      collection: v.collection,
      key: v.key,
      was: before.values,
      now: v.values,
      from: slice && slice.screen,
    });
    variables[at] = v;
    stats.updated++;
  }

  const hygiene = [];
  const seenHy = new Set();
  for (const h of (Array.isArray(prev.hygiene) ? prev.hygiene : []).concat(Array.isArray(nextDoc.hygiene) ? nextDoc.hygiene : [])) {
    const s = String(h);
    if (seenHy.has(s)) continue;
    seenHy.add(s);
    hygiene.push(h);
  }
  for (const c of stats.conflicts) {
    const line =
      `CONFLICT: '${c.name}' (${c.collection}) resolves differently in ${slice && slice.screen ? "'" + slice.screen + "'" : "the newest pull"} ` +
      `than in an earlier pull — the newest value is kept. Check which screen is right before generating a theme.`;
    if (!seenHy.has(line)) {
      seenHy.add(line);
      hygiene.push(line);
    }
  }

  const doc = { collections, variables, hygiene };
  const slices = Array.isArray(prev._slices) ? prev._slices.filter((s) => !slice || s.screen !== slice.screen) : [];
  if (slice) slices.push(sliceEntry(slice, nextDoc));
  doc._slices = slices;
  // Value conflicts are events (a pull changed a known variable), so earlier ones are carried forward
  // rather than wiped by the next pull; same-name conflicts are a property of the union, so they are
  // recomputed from it every time.
  const seenValue = new Set();
  const valueConflicts = [];
  for (const c of (Array.isArray(prev._conflicts) ? prev._conflicts : []).concat(stats.conflicts)) {
    if (!c || c.kind === "same-name") continue;
    const id = JSON.stringify([c.key, c.name, c.collection, c.now, c.from]);
    if (seenValue.has(id)) continue;
    seenValue.add(id);
    valueConflicts.push(Object.assign({ kind: "value" }, c));
  }
  stats.nameConflicts = sameNameConflicts(variables, slices);
  applyNameConflicts(doc, stats.nameConflicts, valueConflicts);
  doc._note = MERGE_NOTE;
  doc.exportedAt = docExportedAt(doc._slices);
  return { doc, stats };
}

const SAME_NAME_PREFIX = "CONFLICT (same name): ";
const short = (k) => (typeof k === "string" && k ? k.slice(0, 8) + "…" : "(no key)");

// Every [collection, name] held by more than one distinct variable in the union.
function sameNameConflicts(variables, slices) {
  const groups = new Map();
  for (const v of variables) {
    if (!v || !v.name) continue;
    const id = String(v.collection || "") + "\u0000" + v.name;
    if (!groups.has(id)) groups.set(id, new Map());
    groups.get(id).set(varId(v), v);
  }
  const out = [];
  for (const members of groups.values()) {
    if (members.size < 2) continue;
    const list = [...members.values()];
    out.push({
      kind: "same-name",
      name: list[0].name,
      collection: list[0].collection,
      sameValue: list.every((v) => resolvesAlike(v, list[0])),
      variants: list.map((v) => ({
        key: v.key,
        values: v.values,
        screens: (slices || []).filter((s) => Array.isArray(s.keys) && s.keys.includes(v.key)).map((s) => s.screen),
      })),
    });
  }
  return out;
}

// Same resolution under different MODE NAMES: `Space 2` = 8 under Desktop/Tablet/Mobile and 8 under
// Mode 1 is one value, and tokens.js emits such a pair once. Shared modes must agree; with no shared
// mode, both must be one constant, and the same one.
function resolvesAlike(a, b) {
  if (sameValue(a, b)) return true;
  if ((a && a.type) !== (b && b.type)) return false;
  const va = (a && a.values) || {}, vb = (b && b.values) || {};
  const shared = Object.keys(va).filter((m) => m in vb);
  if (shared.length) return shared.every((m) => JSON.stringify(va[m]) === JSON.stringify(vb[m]));
  const all = [...Object.values(va), ...Object.values(vb)].map((x) => JSON.stringify(x));
  return all.length > 0 && all.every((x) => x === all[0]);
}

function applyNameConflicts(doc, nameConflicts, valueConflicts) {
  // Stale same-name lines (an earlier union's screen lists) are replaced, not accumulated.
  doc.hygiene = doc.hygiene.filter((h) => !String(h).startsWith(SAME_NAME_PREFIX));
  for (const c of nameConflicts) {
    const parts = c.variants.map((v) => `key ${short(v.key)} = ${JSON.stringify(v.values || {})}` + (v.screens.length ? ` (from ${v.screens.join(", ")})` : ""));
    doc.hygiene.push(
      SAME_NAME_PREFIX +
        `${c.variants.length} different variables are all called '${c.name}'${c.collection ? ` in collection '${c.collection}'` : ""} — ` +
        parts.join(c.sameValue ? " and " : " vs ") + ". " +
        (c.sameValue
          ? "They resolve identically, so a theme emits them once, but they are still two variables."
          : "They resolve DIFFERENTLY. Both are kept here (keyed by Figma key), but anything that looks a token up by NAME gets one of them — " +
            "generate a screen's theme from that screen's own .vars.json (or design-system/tokens.json), not from this union.")
    );
  }
  const all = valueConflicts.concat(nameConflicts);
  if (all.length) doc._conflicts = all;
}

function sliceEntry(slice, doc) {
  const vars = Array.isArray(doc && doc.variables) ? doc.variables : [];
  return {
    screen: slice.screen,
    file: slice.file,
    at: slice.at || new Date().toISOString(),
    variables: vars.length,
    collections: Array.isArray(doc && doc.collections) ? doc.collections.length : 0,
    // Which variables THIS pull carried, by key — the provenance a same-name conflict needs to say
    // which screen each of the two variables came from.
    keys: [...new Set(vars.map((v) => v && v.key).filter((k) => typeof k === "string" && k))].sort(),
  };
}

// A top-level freshness stamp, derived from `_slices[].at` (never invented separately from it) so a
// consumer that expects every export document to carry `exportedAt` (design-diff.js's `previous()`,
// `dtwin doctor`'s export-age check) has one to read (finding 218 — variables.json had none, so the
// stale-baseline check that works for tokens.json could never fire for it). This is a MAX over the
// slice times, i.e. "when did the most recent contributing pull happen" — not a plain re-stamped
// "now", which the prompt is explicit must be avoided: `_slices[].at` legitimately re-appends on every
// re-pull of any ONE screen (finding 223), so `exportedAt` moves whenever slices do, same as they do,
// and nothing here compares variable VALUES by exportedAt equality — that comparison stays keyed
// (`varId`/`sameValue` above), so a moved `exportedAt` alone can never manufacture a fake "token
// changed" the way a naive independent timestamp would.
function docExportedAt(slices) {
  const times = (Array.isArray(slices) ? slices : []).map((s) => s && typeof s.at === "string" ? s.at : null).filter(Boolean);
  return times.length ? times.reduce((mx, t) => (t > mx ? t : mx)) : null;
}

module.exports = { mergeVariablesDoc, sameNameConflicts, varId, collId, MERGE_NOTE, docExportedAt };
